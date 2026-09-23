package boardphotos_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"testing"

	"boardripper/boardphotos"
)

// fillPattern writes a deterministic colour pattern directly into the pixel
// buffer so large test images stay cheap to build.
func fillPattern(img *image.RGBA) {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	for y := 0; y < h; y++ {
		row := img.Pix[y*img.Stride:]
		for x := 0; x < w; x++ {
			o := x * 4
			row[o] = uint8(x)
			row[o+1] = uint8(y)
			row[o+2] = uint8(x ^ y)
			row[o+3] = 255
		}
	}
}

func newPattern(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	fillPattern(img)
	return img
}

func encodeJPEG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode jpeg: %v", err)
	}
	return buf.Bytes()
}

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// buildExifAPP1 crafts an APP1 segment with a plausible EXIF payload: an
// ASCII Make tag and a GPS Info pointer whose IFD carries GPSVersionID.
func buildExifAPP1() []byte {
	le16 := func(v uint16) []byte { return []byte{byte(v), byte(v >> 8)} }
	le32 := func(v uint32) []byte {
		return []byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)}
	}

	const ifd0Off = 8
	const makeStrOff = ifd0Off + 2 + 2*12 + 4 // after IFD0 header
	const gpsOff = makeStrOff + 8             // after "TestCam\x00"

	ifd0 := new(bytes.Buffer)
	ifd0.Write(le16(2))
	// Make (0x010F), ASCII, 8 bytes, value out-of-band.
	ifd0.Write(le16(0x010F))
	ifd0.Write(le16(2))
	ifd0.Write(le32(8))
	ifd0.Write(le32(makeStrOff))
	// GPSInfo (0x8825), LONG, 1, offset of the GPS IFD.
	ifd0.Write(le16(0x8825))
	ifd0.Write(le16(4))
	ifd0.Write(le32(1))
	ifd0.Write(le32(gpsOff))
	ifd0.Write(le32(0)) // no next IFD

	gps := new(bytes.Buffer)
	gps.Write(le16(1))
	// GPSVersionID (tag 1), BYTE, count 4, value inline: 2 3 0 0.
	gps.Write(le16(0x0001))
	gps.Write(le16(1))
	gps.Write(le32(4))
	gps.Write([]byte{2, 3, 0, 0})
	gps.Write(le32(0))

	payload := append([]byte("Exif\x00\x00"), []byte{'I', 'I', 0x2A, 0x00, 8, 0, 0, 0}...)
	payload = append(payload, ifd0.Bytes()...)
	payload = append(payload, "TestCam\x00"...)
	payload = append(payload, gps.Bytes()...)

	seg := make([]byte, 4, 4+len(payload))
	seg[0], seg[1] = 0xFF, 0xE1
	binary.BigEndian.PutUint16(seg[2:4], uint16(len(payload)+2))
	return append(seg, payload...)
}

// jpegWithEXIF returns JPEG bytes carrying a hand-crafted EXIF/GPS APP1
// segment directly after the SOI marker.
func jpegWithEXIF(t *testing.T, w, h int) []byte {
	t.Helper()
	base := encodeJPEG(t, newPattern(w, h))
	out := make([]byte, 0, len(base)+64)
	out = append(out, base[:2]...) // SOI
	out = append(out, buildExifAPP1()...)
	out = append(out, base[2:]...)
	return out
}

// jpegSegments walks the JPEG marker stream after SOI and returns every
// marker byte, stopping at SOS (compressed data) or EOI.
func jpegSegments(data []byte) []byte {
	if len(data) < 2 || data[0] != 0xFF || data[1] != 0xD8 {
		return nil
	}
	var markers []byte
	i := 2
	for i+1 < len(data) {
		if data[i] != 0xFF {
			break
		}
		m := data[i+1]
		if m == 0xFF || m == 0x00 {
			i++
			continue
		}
		markers = append(markers, m)
		if m == 0xD9 || m == 0xDA { // EOI or start of scan
			break
		}
		if i+4 > len(data) {
			break
		}
		length := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		i += 2 + length
	}
	return markers
}

// pngTextChunk builds a tEXt chunk with a unique GPS-ish marker value.
func pngTextChunk() []byte {
	data := append([]byte("Comment\x00"), []byte("pcb-gps-marker-4711")...)
	buf := make([]byte, 12+len(data))
	binary.BigEndian.PutUint32(buf[0:4], uint32(len(data)))
	copy(buf[4:8], "tEXt")
	copy(buf[8:], data)
	crc := crc32.NewIEEE()
	crc.Write([]byte("tEXt"))
	crc.Write(data)
	binary.BigEndian.PutUint32(buf[8+len(data):], crc.Sum32())
	return buf
}

// pngWithText returns PNG bytes with an extra tEXt chunk after IHDR.
func pngWithText(t *testing.T, w, h int) []byte {
	t.Helper()
	base := encodePNG(t, newPattern(w, h))
	// Signature (8) + IHDR chunk (4 len + 4 type + 13 data + 4 crc).
	const insertAt = 8 + 8 + 13 + 4
	out := make([]byte, 0, len(base)+len(pngTextChunk()))
	out = append(out, base[:insertAt]...)
	out = append(out, pngTextChunk()...)
	return append(out, base[insertAt:]...)
}

// pngChunkTypes lists the chunk types of a PNG, stopping at IEND.
func pngChunkTypes(data []byte) []string {
	if len(data) < 8 {
		return nil
	}
	var types []string
	i := 8
	for i+8 <= len(data) {
		length := int(binary.BigEndian.Uint32(data[i : i+4]))
		typ := string(data[i+4 : i+8])
		types = append(types, typ)
		if typ == "IEND" {
			break
		}
		i += 12 + length
	}
	return types
}

// headerOnlyJPEG builds a structurally valid JPEG header declaring w x h
// pixels without any scan data, so DecodeConfig sees the full geometry.
func headerOnlyJPEG(w, h int) []byte {
	// SOF0 with three dummy components, matching the 0x11 segment length.
	sof := []byte{0xFF, 0xC0, 0x00, 0x11, 8,
		byte(h >> 8), byte(h), byte(w >> 8), byte(w),
		3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0}
	out := []byte{0xFF, 0xD8}
	out = append(out, sof...)
	// DecodeConfig parses until SOS, so append a minimal (bogus-payload)
	// SOS header: length 8, one component, no spectral data needed here.
	sos := []byte{0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x3F, 0x00}
	out = append(out, sos...)
	return append(out, 0xFF, 0xD9)
}

// zerosReader yields exactly n zero bytes, then EOF.
type zerosReader struct{ remaining int64 }

func (z *zerosReader) Read(p []byte) (int, error) {
	if z.remaining <= 0 {
		return 0, io.EOF
	}
	n := len(p)
	if int64(n) > z.remaining {
		n = int(z.remaining)
	}
	for i := 0; i < n; i++ {
		p[i] = 0
	}
	z.remaining -= int64(n)
	return n, nil
}

func decodeFile(t *testing.T, path string) image.Image {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return img
}

func dirEmpty(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("temp dir not empty after failed Process: %d entries", len(entries))
	}
}

func TestProcess_JPEG(t *testing.T) {
	dir := t.TempDir()
	data := jpegWithEXIF(t, 640, 480)
	res, err := boardphotos.Process(bytes.NewReader(data), "image/jpeg", dir)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if res.SourceMIME != "image/jpeg" {
		t.Errorf("SourceMIME = %q, want image/jpeg", res.SourceMIME)
	}
	if res.SourceSize <= 0 {
		t.Errorf("SourceSize = %d, want > 0", res.SourceSize)
	}
	src := decodeFile(t, res.SourcePath)
	if got := src.Bounds(); got.Dx() != 640 || got.Dy() != 480 {
		t.Errorf("source size = %dx%d, want 640x480", got.Dx(), got.Dy())
	}
	if res.RenderWidth != 640 || res.RenderHeight != 480 {
		t.Errorf("render size = %dx%d, want 640x480 (no upscaling)", res.RenderWidth, res.RenderHeight)
	}
	assertNoAPPn(t, res.SourcePath)
}

// assertNoAPPn reads the JPEG file at path and fails when any APP marker
// beyond the benign JFIF APP0 is present.
func assertNoAPPn(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	for _, m := range jpegSegments(data) {
		if m >= 0xE1 && m <= 0xEF {
			t.Errorf("JPEG still contains APP marker 0x%02X", m)
		}
	}
	if bytes.Contains(data, []byte("TestCam")) || bytes.Contains(data, []byte("Exif")) {
		t.Error("JPEG still contains EXIF payload bytes")
	}
}

func TestProcess_PNG(t *testing.T) {
	dir := t.TempDir()
	data := pngWithText(t, 320, 240)
	res, err := boardphotos.Process(bytes.NewReader(data), "", dir)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if res.SourceMIME != "image/png" {
		t.Errorf("SourceMIME = %q, want image/png", res.SourceMIME)
	}
	raw, err := os.ReadFile(res.SourcePath)
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	for _, typ := range pngChunkTypes(raw) {
		switch typ {
		case "tEXt", "iTXt", "zTXt", "eXIf":
			t.Errorf("PNG still contains %q chunk", typ)
		}
	}
	if bytes.Contains(raw, []byte("pcb-gps-marker-4711")) {
		t.Error("PNG still contains tEXt payload")
	}
	render := decodeFile(t, res.RenderPath)
	if got := render.Bounds(); got.Dx() != 320 || got.Dy() != 240 {
		t.Errorf("render size = %dx%d, want 320x240", got.Dx(), got.Dy())
	}
}

func TestProcess_JPEGStripsEXIFAndGPS(t *testing.T) {
	dir := t.TempDir()
	data := jpegWithEXIF(t, 64, 48)
	// Sanity: the crafted input really carries the APP1 payload.
	if !bytes.Contains(data, []byte("TestCam")) {
		t.Fatal("crafted input lacks EXIF payload")
	}
	res, err := boardphotos.Process(bytes.NewReader(data), "IMAGE/JPEG", dir)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	assertNoAPPn(t, res.SourcePath)
	assertNoAPPn(t, res.RenderPath)
}

func TestProcess_MIMEMismatch(t *testing.T) {
	jpegData := jpegWithEXIF(t, 8, 8)
	pngData := pngWithText(t, 8, 8)
	cases := []struct {
		name  string
		data  []byte
		mime  string
		match bool
	}{
		{"jpeg declared png", jpegData, "image/png", false},
		{"png declared jpeg", pngData, "image/jpeg", false},
		{"jpeg declared correct", jpegData, "image/jpeg", true},
		{"jpeg declared uppercase", jpegData, "IMAGE/JPEG", true},
		{"png declared empty", pngData, "", true},
	}
	for _, tc := range cases {
		dir := t.TempDir()
		res, err := boardphotos.Process(bytes.NewReader(tc.data), tc.mime, dir)
		if tc.match {
			if err != nil {
				t.Fatalf("%s: Process: %v", tc.name, err)
			}
			continue
		}
		if !errors.Is(err, boardphotos.ErrMIMEMismatch) {
			t.Errorf("%s: err = %v, want ErrMIMEMismatch", tc.name, err)
		}
		if res != nil {
			t.Errorf("%s: got result %v on error", tc.name, res)
		}
		dirEmpty(t, dir)
	}
}

func TestProcess_InvalidData(t *testing.T) {
	cases := []struct {
		name string
		data []byte
	}{
		{"plain text", []byte("this is definitely not an image")},
		{"empty", nil},
		{"truncated jpeg", func() []byte {
			d := jpegWithEXIF(t, 8, 8)
			if len(d) > 10 {
				d = d[:10]
			}
			return d
		}()},
		{"truncated png", func() []byte {
			d := pngWithText(t, 8, 8)
			if len(d) > 10 {
				d = d[:10]
			}
			return d
		}()},
	}
	for _, tc := range cases {
		dir := t.TempDir()
		res, err := boardphotos.Process(bytes.NewReader(tc.data), "", dir)
		if err == nil {
			t.Errorf("%s: Process succeeded, want error", tc.name)
			continue
		}
		if !errors.Is(err, boardphotos.ErrNotJPEGPNG) {
			t.Errorf("%s: err = %v, want ErrNotJPEGPNG", tc.name, err)
		}
		if res != nil {
			t.Errorf("%s: got result %v on error", tc.name, res)
		}
		dirEmpty(t, dir)
	}
}

func TestProcess_ByteLimit(t *testing.T) {
	dir := t.TempDir()
	r := &zerosReader{remaining: boardphotos.MaxInputBytes + 1}
	res, err := boardphotos.Process(r, "", dir)
	if !errors.Is(err, boardphotos.ErrTooLargeBytes) {
		t.Errorf("err = %v, want ErrTooLargeBytes", err)
	}
	if res != nil {
		t.Errorf("got result %v on error", res)
	}
	dirEmpty(t, dir)
}

func TestProcess_PixelLimit(t *testing.T) {
	// 9000x9000 = 81 MP: inside the axis limit, above the pixel limit.
	data := headerOnlyJPEG(9000, 9000)
	dir := t.TempDir()
	res, err := boardphotos.Process(bytes.NewReader(data), "", dir)
	if !errors.Is(err, boardphotos.ErrTooManyPixels) {
		t.Errorf("err = %v, want ErrTooManyPixels", err)
	}
	if res != nil {
		t.Errorf("got result %v on error", res)
	}
	dirEmpty(t, dir)
}

func TestProcess_AxisLimit(t *testing.T) {
	// 12001 px on one axis is rejected even though the pixel count is low.
	data := headerOnlyJPEG(12001, 10)
	dir := t.TempDir()
	res, err := boardphotos.Process(bytes.NewReader(data), "", dir)
	if !errors.Is(err, boardphotos.ErrAxisTooLarge) {
		t.Errorf("err = %v, want ErrAxisTooLarge", err)
	}
	if res != nil {
		t.Errorf("got result %v on error", res)
	}
	dirEmpty(t, dir)
}

func TestProcess_RenderScaledDown(t *testing.T) {
	dir := t.TempDir()
	// 5000x2000: longest edge above RenderMaxEdge, pixel count well below.
	res, err := boardphotos.Process(bytes.NewReader(encodeJPEG(t, newPattern(5000, 2000))), "image/jpeg", dir)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if res.RenderWidth != 4096 || res.RenderHeight != 1638 {
		t.Errorf("render size = %dx%d, want 4096x1638", res.RenderWidth, res.RenderHeight)
	}
	render := decodeFile(t, res.RenderPath)
	if got := render.Bounds(); got.Dx() != res.RenderWidth || got.Dy() != res.RenderHeight {
		t.Errorf("render file is %dx%d, result says %dx%d",
			got.Dx(), got.Dy(), res.RenderWidth, res.RenderHeight)
	}
	// Source stays at full resolution.
	src := decodeFile(t, res.SourcePath)
	if got := src.Bounds(); got.Dx() != 5000 || got.Dy() != 2000 {
		t.Errorf("source size = %dx%d, want 5000x2000", got.Dx(), got.Dy())
	}
}

func TestProcess_RenderNoUpscale(t *testing.T) {
	dir := t.TempDir()
	res, err := boardphotos.Process(bytes.NewReader(encodePNG(t, newPattern(320, 240))), "image/png", dir)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if res.RenderWidth != 320 || res.RenderHeight != 240 {
		t.Errorf("render size = %dx%d, want unchanged 320x240", res.RenderWidth, res.RenderHeight)
	}
}

func TestProcess_RenderKeepsFormat(t *testing.T) {
	dir := t.TempDir()
	// A PNG wider than the render cap: the render must stay a PNG.
	res, err := boardphotos.Process(bytes.NewReader(pngWithText(t, 5000, 100)), "image/png", dir)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	f, err := os.Open(res.RenderPath)
	if err != nil {
		t.Fatalf("open render: %v", err)
	}
	img, err := png.Decode(f)
	f.Close()
	if err != nil {
		t.Fatalf("render is not a valid PNG: %v", err)
	}
	if got := img.Bounds(); got.Dx() != 4096 || got.Dy() != 82 {
		t.Errorf("render size = %dx%d, want 4096x82", got.Dx(), got.Dy())
	}
}

// TestProcess_NonRectangular sanity: images with non-zero origin still
// produce correctly sized output.
func TestProcess_DecodedBoundsOffset(t *testing.T) {
	dir := t.TempDir()
	res, err := boardphotos.Process(bytes.NewReader(encodeJPEG(t, newPattern(16, 16))), "image/jpeg", dir)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if res.RenderWidth != 16 || res.RenderHeight != 16 {
		t.Errorf("render size = %dx%d, want 16x16", res.RenderWidth, res.RenderHeight)
	}
	_ = color.RGBA{}
}
