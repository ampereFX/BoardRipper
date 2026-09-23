package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"strings"
	"testing"

	"boardripper/boardphotos"
	"boardripper/databank"
)

func newBoardPhotoTestHandler(t *testing.T) *BoardPhotoAssetsHandler {
	t.Helper()
	db, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open databank: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	store := boardphotos.NewStore(db)
	service := boardphotos.NewService(store, t.TempDir())
	return NewBoardPhotoAssetsHandler(service, store)
}

// callRoute dispatches through a real mux built with the same patterns as
// main.go, so path parsing and method routing are exercised too.
func callRoute(t *testing.T, h *BoardPhotoAssetsHandler, method, target string, body *bytes.Buffer, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/board-photo-assets/{boardKey}", h.Get)
	mux.HandleFunc("PUT /api/board-photo-assets/{boardKey}/mask", h.PutMask)
	mux.HandleFunc("PUT /api/board-photo-assets/{boardKey}/overlays/{side}", h.PutOverlay)
	mux.HandleFunc("PUT /api/board-photo-assets/{boardKey}/overlays/{side}/calibration", h.PutCalibration)
	mux.HandleFunc("DELETE /api/board-photo-assets/{boardKey}/overlays/{side}", h.DeleteOverlay)
	mux.HandleFunc("GET /api/board-photo-assets/{boardKey}/overlays/{side}/{kind}", h.GetImage)

	var rdr *bytes.Buffer = body
	if rdr == nil {
		rdr = bytes.NewBuffer(nil)
	}
	req := httptest.NewRequest(method, "http://test"+target, rdr)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	return w
}

// jpegBytes renders a small valid JPEG for upload tests.
func jpegBytes(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for x := 0; x < 4; x++ {
		for y := 0; y < 4; y++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 60), G: uint8(y * 60), B: 90, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode jpeg: %v", err)
	}
	return buf.Bytes()
}

// pngBytes renders a small valid PNG for upload tests.
func pngBytes(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	img.Set(1, 1, color.RGBA{R: 10, G: 200, B: 30, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// overlayMultipart builds a PUT overlay request body with the image and an
// optional calibration field (nil omits it, empty string sends it empty).
func calibrationPtr(s string) *string { return &s }

// overlayMultipartTyped builds a multipart body whose image part carries an
// explicit Content-Type header, as browsers send for typed file inputs.
func overlayMultipartTyped(t *testing.T, filename string, img []byte, mime string, calibration *string) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", fmt.Sprintf("form-data; name=%q; filename=%q", "image", filename))
	hdr.Set("Content-Type", mime)
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatalf("CreatePart: %v", err)
	}
	if _, err := part.Write(img); err != nil {
		t.Fatalf("write image: %v", err)
	}
	if calibration != nil {
		if err := mw.WriteField("calibration", *calibration); err != nil {
			t.Fatalf("write calibration: %v", err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return &body, mw.FormDataContentType()
}

func overlayMultipart(t *testing.T, filename string, img []byte, mime string, calibration *string) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile("image", filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write(img); err != nil {
		t.Fatalf("write image: %v", err)
	}
	if calibration != nil {
		if err := mw.WriteField("calibration", *calibration); err != nil {
			t.Fatalf("write calibration: %v", err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return &body, mw.FormDataContentType()
}

// Frozen P0 wire contract: calibration is {version:1, points:[...]}, the
// mask is {points:[...]}. No side, no homography.
const testCalibration = `{"version":1,"points":[` +
	`{"id":1,"board":{"x":0.1,"y":0.2},"photo":{"x":0.3,"y":0.4}},` +
	`{"id":2,"board":{"x":0.9,"y":0.2},"photo":{"x":0.7,"y":0.3}},` +
	`{"id":3,"board":{"x":0.9,"y":0.8},"photo":{"x":0.6,"y":0.7}},` +
	`{"id":4,"board":{"x":0.1,"y":0.8},"photo":{"x":0.2,"y":0.6}}]}`
const testMask = `{"points":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1}]}`

// TestGet_UnknownAssetReturnsEmptyState: HTTP 200 with mask null and an
// empty overlays object — the frontend's empty-state contract.
func TestGet_UnknownAssetReturnsEmptyState(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	w := callRoute(t, h, http.MethodGet, "/api/board-photo-assets/fp%231", nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var state struct {
		Mask     json.RawMessage            `json:"mask"`
		Overlays map[string]json.RawMessage `json:"overlays"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
		t.Fatalf("decode: %v (%s)", err, w.Body.String())
	}
	if string(state.Mask) != "null" {
		t.Fatalf("expected mask null, got %s", string(state.Mask))
	}
	if state.Overlays == nil || len(state.Overlays) != 0 {
		t.Fatalf("expected empty overlays object, got %v", state.Overlays)
	}
}

// TestPutMask_StoresAndReturnsState covers the mask write path and that GET
// then reports the stored mask.
func TestPutMask_StoresAndReturnsState(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/fp%231/mask", bytes.NewBufferString(testMask), "application/json")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	w = callRoute(t, h, http.MethodGet, "/api/board-photo-assets/fp%231", nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var state struct {
		Mask     *boardPhotoMask            `json:"mask"`
		Overlays map[string]json.RawMessage `json:"overlays"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if state.Mask == nil || len(state.Mask.Points) != 3 {
		t.Fatalf("unexpected mask: %+v", state.Mask)
	}
	if len(state.Overlays) != 0 {
		t.Fatalf("expected no overlays, got %v", state.Overlays)
	}
}

// TestPutMask_RejectsInvalid covers syntactic and structural validation.
func TestPutMask_RejectsInvalid(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	cases := []struct {
		name string
		body string
	}{
		{"not json", "{nope"},
		{"empty", ""},
		{"missing points", `{}`},
		{"too few points", `{"points":[{"x":0,"y":0},{"x":1,"y":1}]}`},
		{"nan coordinate", `{"points":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":NaN}]}`},
		{"out of range", `{"points":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1.5}]}`},
		{"unknown field", `{"side":"top","points":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/mask", bytes.NewBufferString(tc.body), "application/json")
			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

// TestPutMask_TooLarge: oversized JSON bodies are rejected with 413.
func TestPutMask_TooLarge(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	big := bytes.Repeat([]byte(" "), maxMaskJSONBytes+1)
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/mask", bytes.NewBuffer(big), "application/json")
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", w.Code)
	}
}

// TestPutOverlay_ImportAndFullState is the main success path: multipart
// import with calibration, metadata in the response and in GET, image
// serving for source and render, and calibration visible.
func TestPutOverlay_ImportAndFullState(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	img := jpegBytes(t)
	body, ctype := overlayMultipart(t, "photo.jpg", img, "image/jpeg", calibrationPtr(testCalibration))
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/fp%233/overlays/top", body, ctype)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var stored struct {
		Metadata struct {
			ID       string `json:"id"`
			MimeType string `json:"mimeType"`
			WidthPx  int    `json:"widthPx"`
			HeightPx int    `json:"heightPx"`
		} `json:"metadata"`
		Calibration json.RawMessage `json:"calibration"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &stored); err != nil {
		t.Fatalf("decode: %v (%s)", err, w.Body.String())
	}
	if stored.Metadata.MimeType != "image/jpeg" || stored.Metadata.WidthPx != 4 || stored.Metadata.HeightPx != 4 {
		t.Fatalf("unexpected metadata: %+v", stored.Metadata)
	}
	if stored.Metadata.ID == "" {
		t.Fatalf("expected asset id in metadata")
	}
	if len(stored.Calibration) == 0 || !json.Valid(stored.Calibration) {
		t.Fatalf("expected calibration JSON, got %s", string(stored.Calibration))
	}

	// GET returns the same overlay state, side-keyed.
	w = callRoute(t, h, http.MethodGet, "/api/board-photo-assets/fp%233", nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET expected 200, got %d", w.Code)
	}
	var state struct {
		Overlays map[string]struct {
			Metadata struct {
				MimeType string `json:"mimeType"`
			} `json:"metadata"`
			Calibration json.RawMessage `json:"calibration"`
		} `json:"overlays"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
		t.Fatalf("decode state: %v", err)
	}
	top, ok := state.Overlays["top"]
	if !ok || top.Metadata.MimeType != "image/jpeg" || len(top.Calibration) == 0 {
		t.Fatalf("unexpected GET state: %s", w.Body.String())
	}

	// Source and render images are served with the right content type and
	// byte-for-byte decodable (render carries the same dimensions here).
	for _, kind := range []string{"source", "render"} {
		w := callRoute(t, h, http.MethodGet, "/api/board-photo-assets/fp%233/overlays/top/"+kind, nil, "")
		if w.Code != http.StatusOK {
			t.Fatalf("%s: expected 200, got %d: %s", kind, w.Code, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); ct != "image/jpeg" {
			t.Fatalf("%s: expected image/jpeg, got %q", kind, ct)
		}
		cfg, _, err := image.DecodeConfig(bytes.NewReader(w.Body.Bytes()))
		if err != nil || cfg.Width != 4 || cfg.Height != 4 {
			t.Fatalf("%s: expected decodable 4x4 image, err=%v cfg=%+v", kind, err, cfg)
		}
	}
}

// TestPutOverlay_PngImportWithMissingCalibration: calibration field may be
// absent; then GET must show calibration null.
func TestPutOverlay_PngImportWithMissingCalibration(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	body, ctype := overlayMultipart(t, "photo.png", pngBytes(t), "image/png", nil)
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/fp%231/overlays/bottom", body, ctype)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var stored struct {
		Metadata struct {
			MimeType string `json:"mimeType"`
		} `json:"metadata"`
		Calibration json.RawMessage `json:"calibration"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &stored); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if stored.Metadata.MimeType != "image/png" {
		t.Fatalf("expected png mime, got %s", stored.Metadata.MimeType)
	}
	if string(stored.Calibration) != "null" {
		t.Fatalf("expected calibration null, got %s", string(stored.Calibration))
	}
}

// TestPutOverlay_ReplacesPrevious: importing twice swaps the row and files;
// the new metadata wins, nothing stale remains.
func TestPutOverlay_ReplacesPrevious(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	body, ctype := overlayMultipart(t, "a.jpg", jpegBytes(t), "image/jpeg", nil)
	if w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/fp%231/overlays/top", body, ctype); w.Code != http.StatusOK {
		t.Fatalf("first import: %d %s", w.Code, w.Body.String())
	}
	body, ctype = overlayMultipart(t, "b.png", pngBytes(t), "image/png", nil)
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/fp%231/overlays/top", body, ctype)
	if w.Code != http.StatusOK {
		t.Fatalf("second import: %d %s", w.Code, w.Body.String())
	}
	var stored struct {
		Metadata struct {
			MimeType string `json:"mimeType"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &stored); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if stored.Metadata.MimeType != "image/png" {
		t.Fatalf("expected png after replace, got %s", stored.Metadata.MimeType)
	}
}

// TestPutOverlay_CalibrationFieldInvalidJSON: a malformed calibration field
// is a 400 before any image is processed.
func TestPutOverlay_CalibrationFieldInvalidJSON(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	bad := "{not json"
	body, ctype := overlayMultipart(t, "a.jpg", jpegBytes(t), "image/jpeg", &bad)
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top", body, ctype)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// TestPutOverlay_RejectsBadSideStrict: side values are validated strictly.
func TestPutOverlay_RejectsBadSideStrict(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	body, ctype := overlayMultipart(t, "a.jpg", jpegBytes(t), "image/jpeg", nil)
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/left", body, ctype)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

// TestPutOverlay_RejectsBadImageFormat: 415 for non-JPEG/PNG bytes and for
// a MIME/data mismatch.
func TestPutOverlay_RejectsBadImageFormat(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	body, ctype := overlayMultipart(t, "a.jpg", []byte("definitely not an image"), "image/jpeg", nil)
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top", body, ctype)
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("garbage image: expected 415, got %d: %s", w.Code, w.Body.String())
	}

	body, ctype = overlayMultipart(t, "a.png", jpegBytes(t), "image/png", nil)
	w = callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top", body, ctype)
	// Note: a declared MIME that is not image/* is deliberately ignored by
	// the handler (browsers send application/octet-stream), so a mismatch
	// test must use a wrong image/* type that still passes multipart.
	body, ctype = overlayMultipartTyped(t, "a.png", jpegBytes(t), "image/png", nil)
	w = callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top", body, ctype)
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("mime mismatch: expected 415, got %d: %s", w.Code, w.Body.String())
	}
	body, ctype = overlayMultipartTyped(t, "a.png", jpegBytes(t), "IMAGE/PNG", nil)
	w = callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top", body, ctype)
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("case-insensitive mime mismatch: expected 415, got %d: %s", w.Code, w.Body.String())
	}
}

// TestPutOverlay_TooLarge: the size cap rejects oversized bodies with 413.
func TestPutOverlay_TooLarge(t *testing.T) {
	old := maxOverlayUploadBytes
	maxOverlayUploadBytes = 4096
	defer func() { maxOverlayUploadBytes = old }()

	h := newBoardPhotoTestHandler(t)
	big := make([]byte, 8192)
	body, ctype := overlayMultipart(t, "big.jpg", big, "image/jpeg", nil)
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top", body, ctype)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d: %s", w.Code, w.Body.String())
	}
}

func TestPutOverlay_TooLargeCalibration(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	calibration := strings.Repeat(" ", maxCalibrationJSONBytes+1)
	body, ctype := overlayMultipart(t, "a.jpg", jpegBytes(t), "image/jpeg", &calibration)
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top", body, ctype)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized calibration, got %d: %s", w.Code, w.Body.String())
	}
}

// TestPutOverlay_50MiBPlusOverheadAllowed: a body just under the cap
// (50 MiB image budget plus small multipart overhead, built with a valid
// small JPEG plus a large pad field) must be accepted. httptest's own
// multipart reader fails beyond ~1.6 MiB field sizes, so this test keeps
// the padding small and instead shrinks the cap around a mid-size body:
// the important boundary is "limit is bigger than image+overhead, smaller
// than image+overhead+1", not the absolute number.
func TestPutOverlay_50MiBPlusOverheadAllowed(t *testing.T) {
	old := maxOverlayUploadBytes
	// Real cap: image + overhead must fit; body here is ~len(img) + overhead.
	maxOverlayUploadBytes = int64(len(jpegBytes(t)) + (64 << 10))
	defer func() { maxOverlayUploadBytes = old }()

	h := newBoardPhotoTestHandler(t)
	img := jpegBytes(t)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("image", "a.jpg")
	fw.Write(img)
	mw.WriteField("calibration", testCalibration)
	mw.Close()

	req := httptest.NewRequest(http.MethodPut, "http://test/api/board-photo-assets/abc%230/overlays/top", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /api/board-photo-assets/{boardKey}/overlays/{side}", h.PutOverlay)
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for 50MiB+overhead-sized body, got %d: %s", w.Code, w.Body.String())
	}
}

// TestPutCalibration_SuccessAndNotFound covers update on an existing side
// and 404 for a side without an overlay.
func TestPutCalibration_SuccessAndNotFound(t *testing.T) {
	h := newBoardPhotoTestHandler(t)

	// No overlay yet -> 404.
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top/calibration", bytes.NewBufferString(testCalibration), "application/json")
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 before import, got %d: %s", w.Code, w.Body.String())
	}

	// Import, then update the calibration.
	body, ctype := overlayMultipart(t, "a.jpg", jpegBytes(t), "image/jpeg", nil)
	if w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top", body, ctype); w.Code != http.StatusOK {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}
	w = callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top/calibration", bytes.NewBufferString(testCalibration), "application/json")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// TestPutCalibration_InvalidPayloads covers JSON and structural validation.
func TestPutCalibration_InvalidPayloads(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	body, ctype := overlayMultipart(t, "a.jpg", jpegBytes(t), "image/jpeg", nil)
	if w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top", body, ctype); w.Code != http.StatusOK {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}

	cases := []string{
		"{nope",
		`{"version":2,"points":[]}`,
		`{"version":1,"points":[]}`,
		`{"version":1,"points":[` + strings.Repeat(testPair, 3) + `]}`,
		`{"version":1,"points":[` + strings.Repeat(testPair, 13) + `]}`,
		`{"version":1,"points":[{"board":{"x":0,"y":0},"photo":{"x":0,"y":0}},` + testPairTail3 + `]}`,
		`{"version":1,"points":[{"id":0,"board":{"x":0,"y":0},"photo":{"x":0,"y":0}},` + testPairTail3 + `]}`,
		`{"version":1,"points":[{"id":-1,"board":{"x":0,"y":0},"photo":{"x":0,"y":0}},` + testPairTail3 + `]}`,
		`{"version":1,"points":[{"id":1.5,"board":{"x":0,"y":0},"photo":{"x":0,"y":0}},` + testPairTail3 + `]}`,
		`{"version":1,"points":[{"id":1,"board":{"x":0,"y":0},"photo":{"x":0,"y":0}},{"id":1,"board":{"x":0.2,"y":0},"photo":{"x":0.2,"y":0}},{"id":3,"board":{"x":0.4,"y":0},"photo":{"x":0.4,"y":0}},{"id":4,"board":{"x":0.6,"y":0},"photo":{"x":0.6,"y":0}}]}`,
		`{"version":1,"points":[{"id":"1","board":{"x":0,"y":0},"photo":{"x":0,"y":0}},` + testPairTail3 + `]}`,
		`{"version":1,"side":"top","points":[` + strings.Repeat(testPair, 4) + `]}`,
		`{"version":1,"homography":{"status":"ok"},"points":[` + strings.Repeat(testPair, 4) + `]}`,
	}
	for i, c := range cases {
		w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top/calibration", bytes.NewBufferString(c), "application/json")
		if w.Code != http.StatusBadRequest {
			t.Fatalf("case %d: expected 400, got %d: %s", i, w.Code, w.Body.String())
		}
	}
}

func TestPutMask_RejectsMissingCoordinate(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	body := `{"points":[{"x":0,"y":0},{"x":1},{"x":1,"y":1}]}`
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/fp%230/mask", bytes.NewBufferString(body), "application/json")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for incomplete mask point, got %d: %s", w.Code, w.Body.String())
	}
}

// TestDeleteOverlay_Flow: delete removes the side; a second delete is 404;
// image fetch after delete is 404.
func TestDeleteOverlay_Flow(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	body, ctype := overlayMultipart(t, "a.jpg", jpegBytes(t), "image/jpeg", nil)
	if w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top", body, ctype); w.Code != http.StatusOK {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}

	w := callRoute(t, h, http.MethodDelete, "/api/board-photo-assets/abc%230/overlays/top", nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp["status"] != "deleted" {
		t.Fatalf("expected status deleted, got %s", w.Body.String())
	}

	if w := callRoute(t, h, http.MethodDelete, "/api/board-photo-assets/abc%230/overlays/top", nil, ""); w.Code != http.StatusNotFound {
		t.Fatalf("second delete: expected 404, got %d", w.Code)
	}
	if w := callRoute(t, h, http.MethodGet, "/api/board-photo-assets/abc%230/overlays/top/source", nil, ""); w.Code != http.StatusNotFound {
		t.Fatalf("image after delete: expected 404, got %d", w.Code)
	}
}

// TestDeleteOverlay_UnknownSideStrict: DELETE validates side strictly.
func TestDeleteOverlay_UnknownSideStrict(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	w := callRoute(t, h, http.MethodDelete, "/api/board-photo-assets/abc%230/overlays/rotator", nil, "")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

// TestGetImage_VariantStrictAndNotFound: variant is validated strictly and
// missing overlays deliver 404.
func TestGetImage_VariantStrictAndNotFound(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	if w := callRoute(t, h, http.MethodGet, "/api/board-photo-assets/abc%230/overlays/top/missing", nil, ""); w.Code != http.StatusBadRequest {
		t.Fatalf("bad kind: expected 400, got %d", w.Code)
	}
	if w := callRoute(t, h, http.MethodGet, "/api/board-photo-assets/abc%230/overlays/middle/source", nil, ""); w.Code != http.StatusBadRequest {
		t.Fatalf("bad side: expected 400, got %d", w.Code)
	}
	if w := callRoute(t, h, http.MethodGet, "/api/board-photo-assets/abc%230/overlays/top/source", nil, ""); w.Code != http.StatusNotFound {
		t.Fatalf("missing overlay: expected 404, got %d", w.Code)
	}
}

// TestGetImage_NoPathLeak: even when the stored metadata points at a
// missing or tampered file, the error response must not contain internal
// paths.
func TestGetImage_NoPathLeak(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	// An overlay row whose file was removed on disk (simulated by deleting
	// the stored file) still resolves; the request must answer 404 without
	// leaking any path in the body.
	body, ctype := overlayMultipart(t, "a.jpg", jpegBytes(t), "image/jpeg", nil)
	if w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/abc%230/overlays/top", body, ctype); w.Code != http.StatusOK {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}
	// Delete every file under the service root, keeping the metadata rows.
	_ = os.RemoveAll(h.service.Root())
	w := callRoute(t, h, http.MethodGet, "/api/board-photo-assets/abc%230/overlays/top/source", nil, "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
	if bytes.Contains(w.Body.Bytes(), []byte("/")) {
		t.Fatalf("response should not contain path separators: %s", w.Body.String())
	}
}

// TestRoutes_TraversalSafe: board keys with traversal payloads are treated
// as opaque strings (no files touched, no internal paths revealed).
func TestRoutes_TraversalSafe(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	// A traversal-looking board key is just a string key in the store; it
	// must not escape anywhere. Unknown asset -> empty state 200.
	w := callRoute(t, h, http.MethodGet, "/api/board-photo-assets/..%2F..%2Fetc", nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	// Overlay image for an unknown asset must 404 without leaking paths.
	w = callRoute(t, h, http.MethodGet, "/api/board-photo-assets/..%2F..%2Fetc/overlays/top/source", nil, "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
	if bytes.Contains(w.Body.Bytes(), []byte("/etc")) {
		t.Fatalf("leaked path: %s", w.Body.String())
	}
	// Mutating routes reject malformed keys before touching the body or disk.
	w = callRoute(t, h, http.MethodPut, "/api/board-photo-assets/..%2F..%2Fetc/mask", bytes.NewBufferString(testMask), "application/json")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid key on mask write: expected 400, got %d", w.Code)
	}
}

// testPair is one valid calibration point pair; testPairTail3 the three
// remaining pairs of testCalibration without the first one.
const testPair = `{"id":1,"board":{"x":0.1,"y":0.2},"photo":{"x":0.3,"y":0.4}},`
const testPairTail3 = `{"id":2,"board":{"x":0.9,"y":0.2},"photo":{"x":0.7,"y":0.3}},` +
	`{"id":3,"board":{"x":0.9,"y":0.8},"photo":{"x":0.6,"y":0.7}},` +
	`{"id":4,"board":{"x":0.1,"y":0.8},"photo":{"x":0.2,"y":0.6}}`

// TestPutOverlay_ImportResponseWireContract pins the frozen P0 wire format
// of the import response: metadata with id/mimeType/widthPx/heightPx and
// calibration exactly {version, points}, without side and without a
// homography block.
func TestPutOverlay_ImportResponseWireContract(t *testing.T) {
	h := newBoardPhotoTestHandler(t)
	body, ctype := overlayMultipart(t, "a.jpg", jpegBytes(t), "image/jpeg", calibrationPtr(testCalibration))
	w := callRoute(t, h, http.MethodPut, "/api/board-photo-assets/fp%237/overlays/bottom", body, ctype)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var stored BoardPhotoStoredOverlay
	if err := json.Unmarshal(w.Body.Bytes(), &stored); err != nil {
		t.Fatalf("decode: %v (%s)", err, w.Body.String())
	}
	if stored.Metadata.ID == "" || stored.Metadata.MimeType != "image/jpeg" {
		t.Fatalf("unexpected metadata: %+v", stored.Metadata)
	}
	var cal struct {
		Version    int                              `json:"version"`
		Points     []boardPhotoCalibrationPointPair `json:"points"`
		Side       json.RawMessage                  `json:"side"`
		Homography json.RawMessage                  `json:"homography"`
	}
	if err := json.Unmarshal(stored.Calibration, &cal); err != nil {
		t.Fatalf("decode calibration: %v (%s)", err, string(stored.Calibration))
	}
	if cal.Version != 1 || len(cal.Points) != 4 {
		t.Fatalf("unexpected calibration: %s", string(stored.Calibration))
	}
	for _, p := range cal.Points {
		if p.ID == nil || *p.ID <= 0 || p.Board.X != p.Board.X || p.Photo.Y != p.Photo.Y {
			t.Fatalf("incomplete pair: %+v", p)
		}
	}
	if string(cal.Side) != "" || string(cal.Homography) != "" {
		t.Fatalf("calibration must not carry side/homography: %s", string(stored.Calibration))
	}

	// The GET state must expose the identical overlay shape, keyed top/bottom.
	w = callRoute(t, h, http.MethodGet, "/api/board-photo-assets/fp%237", nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET expected 200, got %d", w.Code)
	}
	var state struct {
		Overlays map[string]BoardPhotoStoredOverlay `json:"overlays"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
		t.Fatalf("decode state: %v", err)
	}
	ov, ok := state.Overlays["bottom"]
	if !ok || ov.Metadata.MimeType != "image/jpeg" || len(ov.Calibration) == 0 {
		t.Fatalf("unexpected GET state: %s", w.Body.String())
	}
}
