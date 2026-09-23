package boardphotos

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"image/png"
	"io"
	"math"
	"os"
	"strings"
)

// Hard limits for uploaded PCB photos.
const (
	// MaxInputBytes is the largest accepted encoded input, 50 MiB.
	MaxInputBytes = 50 << 20
	// MaxPixels is the largest accepted pixel count (50 megapixels).
	MaxPixels = 50_000_000
	// MaxAxisPx is the largest accepted width or height in pixels.
	MaxAxisPx = 12_000
	// RenderMaxEdge caps the longest edge of the generated render copy.
	RenderMaxEdge = 4096
)

// jpegQuality is used for all cleaned JPEG output (source and render).
const jpegQuality = 90

var (
	// ErrTooLargeBytes reports input exceeding MaxInputBytes.
	ErrTooLargeBytes = errors.New("boardphotos: image input exceeds 50 MiB")
	// ErrTooManyPixels reports an image exceeding MaxPixels.
	ErrTooManyPixels = errors.New("boardphotos: image exceeds 50 megapixels")
	// ErrAxisTooLarge reports an image exceeding MaxAxisPx on one axis.
	ErrAxisTooLarge = errors.New("boardphotos: image exceeds 12000 px per axis")
	// ErrNotJPEGPNG reports data that is neither a valid JPEG nor PNG.
	ErrNotJPEGPNG = errors.New("boardphotos: only JPEG and PNG images are accepted")
	// ErrMIMEMismatch reports a declared MIME type that contradicts the
	// actual image data.
	ErrMIMEMismatch = errors.New("boardphotos: declared MIME type does not match image data")
)

// Processed holds the two files Process wrote into the temporary directory.
// Both paths are freshly generated names inside that directory, so the caller
// can os.Rename them to their final destinations without ever building a path
// from untrusted input.
type Processed struct {
	SourcePath   string // cleaned copy in the original JPEG/PNG format
	SourceMIME   string // "image/jpeg" or "image/png"
	SourceSize   int64  // size of the cleaned source file in bytes
	RenderPath   string // render copy, longest edge at most RenderMaxEdge
	RenderWidth  int
	RenderHeight int
}

// Process reads one image, enforces the size and dimension limits, decodes
// it and writes two re-encoded files into dir (which must already exist):
// the cleaned source in its original format and a render scaled so its
// longest edge is at most RenderMaxEdge (no upscaling). Decoding and
// re-encoding strips all metadata such as EXIF, GPS or PNG text chunks.
// declaredMIME may be empty; when set it must match the detected format.
// On error any partially written files are removed. Neither this package nor
// the result names encode any caller-provided string.
func Process(r io.Reader, declaredMIME string, dir string) (*Processed, error) {
	data, err := readLimited(r)
	if err != nil {
		return nil, err
	}
	format, ok := sniffFormat(data)
	if !ok {
		return nil, ErrNotJPEGPNG
	}
	if err := checkMIME(declaredMIME, format); err != nil {
		return nil, err
	}

	// DecodeConfig is cheap (no pixel buffers) and rejects bogus or
	// oversized headers before the full decode allocates anything.
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotJPEGPNG, err)
	}
	if err := checkDims(cfg.Width, cfg.Height); err != nil {
		return nil, err
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotJPEGPNG, err)
	}
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	// Re-check the decoded reality; headers can lie about the geometry.
	if err := checkDims(w, h); err != nil {
		return nil, err
	}

	ext := ".png"
	if format == "jpeg" {
		ext = ".jpg"
	}

	srcPath, srcSize, err := writeImageFile(dir, "source-*"+ext, img, format)
	if err != nil {
		return nil, err
	}

	rw, rh := renderDims(w, h)
	renderImg := img
	if rw != w || rh != h {
		renderImg = resizeBilinear(img, rw, rh)
	}
	renderPath, _, err := writeImageFile(dir, "render-*"+ext, renderImg, format)
	if err != nil {
		os.Remove(srcPath)
		return nil, err
	}

	return &Processed{
		SourcePath:   srcPath,
		SourceMIME:   mimeFor(format),
		SourceSize:   srcSize,
		RenderPath:   renderPath,
		RenderWidth:  rw,
		RenderHeight: rh,
	}, nil
}

// readLimited reads r but fails once more than MaxInputBytes arrives.
func readLimited(r io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, MaxInputBytes+1))
	if err != nil {
		return nil, fmt.Errorf("boardphotos: read image: %w", err)
	}
	if len(data) > MaxInputBytes {
		return nil, ErrTooLargeBytes
	}
	return data, nil
}

// sniffFormat detects JPEG and PNG by their magic bytes.
func sniffFormat(data []byte) (format string, ok bool) {
	if len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
		return "jpeg", true
	}
	if len(data) >= 8 && bytes.Equal(data[:8], []byte("\x89PNG\r\n\x1a\n")) {
		return "png", true
	}
	return "", false
}

func mimeFor(format string) string {
	if format == "jpeg" {
		return "image/jpeg"
	}
	return "image/png"
}

// checkMIME validates the optional declared MIME type against the detected
// format. Comparison is case-insensitive and ignores surrounding whitespace.
func checkMIME(declared, format string) error {
	declared = strings.ToLower(strings.TrimSpace(declared))
	want := mimeFor(format)
	if declared == "" || declared == want {
		return nil
	}
	return fmt.Errorf("%w: declared %q, data is %s", ErrMIMEMismatch, declared, want)
}

// checkDims enforces the pixel limits using 64-bit arithmetic so the width
// times height product cannot overflow.
func checkDims(w, h int) error {
	if w <= 0 || h <= 0 {
		return fmt.Errorf("%w: degenerate size %dx%d", ErrNotJPEGPNG, w, h)
	}
	if w > MaxAxisPx || h > MaxAxisPx {
		return fmt.Errorf("%w: %dx%d", ErrAxisTooLarge, w, h)
	}
	if int64(w)*int64(h) > MaxPixels {
		return fmt.Errorf("%w: %dx%d", ErrTooManyPixels, w, h)
	}
	return nil
}

// renderDims returns the render size: the input size when it already fits,
// otherwise a proportional scale-down whose longest edge is RenderMaxEdge.
func renderDims(w, h int) (int, int) {
	if w <= RenderMaxEdge && h <= RenderMaxEdge {
		return w, h
	}
	scale := float64(RenderMaxEdge) / float64(max(w, h))
	nw := max(1, int(math.Round(float64(w)*scale)))
	nh := max(1, int(math.Round(float64(h)*scale)))
	return nw, nh
}

// writeImageFile re-encodes img (dropping any metadata) into a new temporary
// file in dir and closes it before returning its path and size.
func writeImageFile(dir, pattern string, img image.Image, format string) (path string, size int64, err error) {
	f, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", 0, fmt.Errorf("boardphotos: create temp file: %w", err)
	}
	if format == "jpeg" {
		err = jpeg.Encode(f, img, &jpeg.Options{Quality: jpegQuality})
	} else {
		err = png.Encode(f, img)
	}
	if err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", 0, fmt.Errorf("boardphotos: encode %s: %w", format, err)
	}
	info, statErr := f.Stat()
	closeErr := f.Close()
	if statErr != nil {
		os.Remove(f.Name())
		return "", 0, fmt.Errorf("boardphotos: stat temp file: %w", statErr)
	}
	if closeErr != nil {
		os.Remove(f.Name())
		return "", 0, fmt.Errorf("boardphotos: close temp file: %w", closeErr)
	}
	return f.Name(), info.Size(), nil
}

// resizeBilinear scales src to dstW x dstH using bilinear interpolation.
// src is first flattened into a premultiplied RGBA buffer so every source
// format (paletted, gray, YCbCr, ...) shares one sampling path.
func resizeBilinear(src image.Image, dstW, dstH int) *image.RGBA {
	b := src.Bounds()
	flat := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(flat, flat.Bounds(), src, b.Min, draw.Src)

	srcW, srcH := flat.Bounds().Dx(), flat.Bounds().Dy()
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	xRatio := float64(srcW) / float64(dstW)
	yRatio := float64(srcH) / float64(dstH)

	at := func(x, y int) int { return y*flat.Stride + x*4 }
	for y := 0; y < dstH; y++ {
		fy := (float64(y)+0.5)*yRatio - 0.5
		y0 := clampIndex(int(math.Floor(fy)), srcH)
		y1 := clampIndex(y0+1, srcH)
		yFrac := clampFrac(fy - math.Floor(fy))
		di := y * dst.Stride
		for x := 0; x < dstW; x++ {
			fx := (float64(x)+0.5)*xRatio - 0.5
			x0 := clampIndex(int(math.Floor(fx)), srcW)
			x1 := clampIndex(x0+1, srcW)
			xFrac := clampFrac(fx - math.Floor(fx))
			i00, i10 := at(x0, y0), at(x1, y0)
			i01, i11 := at(x0, y1), at(x1, y1)
			for c := 0; c < 4; c++ {
				top := lerp(float64(flat.Pix[i00+c]), float64(flat.Pix[i10+c]), xFrac)
				bottom := lerp(float64(flat.Pix[i01+c]), float64(flat.Pix[i11+c]), xFrac)
				dst.Pix[di+c] = uint8(math.Round(lerp(top, bottom, yFrac)))
			}
			di += 4
		}
	}
	return dst
}

func lerp(a, b, t float64) float64 { return a + (b-a)*t }

func clampIndex(i, n int) int {
	if i < 0 {
		return 0
	}
	if i > n-1 {
		return n - 1
	}
	return i
}

func clampFrac(t float64) float64 {
	if t < 0 {
		return 0
	}
	if t > 1 {
		return 1
	}
	return t
}
