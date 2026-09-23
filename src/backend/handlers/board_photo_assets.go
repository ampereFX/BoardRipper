package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"

	"boardripper/boardphotos"
)

// maxOverlayUploadBytes caps the multipart PUT body: one 50 MiB image plus
// a small multipart overhead must pass, unbounded reads are prevented. A
// variable (not a const) so tests can shrink it.
var maxOverlayUploadBytes int64 = (50 << 20) + (64 << 10)

// Max sizes for the JSON PUT bodies (mask / calibration).
const (
	maxMaskJSONBytes        = 64 << 10
	maxCalibrationJSONBytes = 64 << 10
)

// errInvalidBoardPhotoJSON marks a syntactically or structurally invalid
// mask / calibration payload. Errors wrapping it map to HTTP 400.
var errInvalidBoardPhotoJSON = errors.New("invalid JSON payload")

var errBoardPhotoCalibrationTooLarge = errors.New("calibration payload too large")

// BoardPhotoAssetsHandler serves the REST surface for board photo overlays:
// asset state (mask + per-side overlay metadata), overlay image imports,
// calibration updates, deletions and private image delivery.
type BoardPhotoAssetsHandler struct {
	service *boardphotos.Service
	store   *boardphotos.Store
}

func NewBoardPhotoAssetsHandler(service *boardphotos.Service, store *boardphotos.Store) *BoardPhotoAssetsHandler {
	return &BoardPhotoAssetsHandler{service: service, store: store}
}

// BoardPhotoAssetState is the JSON wire format of GET
// /api/board-photo-assets/{boardKey}, matching the frontend
// BoardPhotoAssetState type.
type BoardPhotoAssetState struct {
	Mask     json.RawMessage                    `json:"mask"`
	Overlays map[string]BoardPhotoStoredOverlay `json:"overlays"`
}

// BoardPhotoStoredOverlay carries the metadata of one side plus its
// calibration (null while uncalibrated), matching the frontend
// StoredOverlay type.
type BoardPhotoStoredOverlay struct {
	Metadata    BoardPhotoOverlayMetadata `json:"metadata"`
	Calibration json.RawMessage           `json:"calibration"`
}

// BoardPhotoOverlayMetadata matches the frontend OverlayAssetMetadata type.
type BoardPhotoOverlayMetadata struct {
	ID       string `json:"id"`
	MimeType string `json:"mimeType"`
	WidthPx  int    `json:"widthPx"`
	HeightPx int    `json:"heightPx"`
}

// Get returns the full state (mask + overlays) for one board key. An asset
// that does not exist is not a 404: the frontend expects HTTP 200 with the
// empty state (mask null, overlays as an empty object).
func (h *BoardPhotoAssetsHandler) Get(w http.ResponseWriter, r *http.Request) {
	boardKey := r.PathValue("boardKey")
	if boardKey == "" {
		http.Error(w, `{"error":"missing board key"}`, http.StatusBadRequest)
		return
	}

	asset, err := h.store.GetAsset(boardKey)
	if errors.Is(err, boardphotos.ErrNotFound) {
		writeBoardPhotoJSON(w, http.StatusOK, BoardPhotoAssetState{Overlays: map[string]BoardPhotoStoredOverlay{}})
		return
	}
	if err != nil {
		http.Error(w, `{"error":"failed to read asset"}`, http.StatusInternalServerError)
		return
	}

	state := BoardPhotoAssetState{Overlays: map[string]BoardPhotoStoredOverlay{}}
	if asset.ManualMask != "" {
		state.Mask = json.RawMessage(asset.ManualMask)
	}
	for _, side := range []string{boardphotos.SideTop, boardphotos.SideBottom} {
		ov, err := h.store.GetOverlay(boardKey, side)
		if errors.Is(err, boardphotos.ErrNotFound) {
			continue
		}
		if err != nil {
			http.Error(w, `{"error":"failed to read overlays"}`, http.StatusInternalServerError)
			return
		}
		state.Overlays[side] = boardPhotoStoredOverlayJSON(ov)
	}
	writeBoardPhotoJSON(w, http.StatusOK, state)
}

// PutMask stores the manually drawn board mask for one board key.
func (h *BoardPhotoAssetsHandler) PutMask(w http.ResponseWriter, r *http.Request) {
	boardKey := r.PathValue("boardKey")
	if err := boardphotos.ValidateBoardKey(boardKey); err != nil {
		http.Error(w, boardPhotoErrorBody(err), http.StatusBadRequest)
		return
	}
	body, ok := readBoardPhotoJSONBody(w, r, maxMaskJSONBytes, "mask")
	if !ok {
		return
	}
	if err := validateBoardPhotoMask(body); err != nil {
		http.Error(w, boardPhotoErrorBody(err), http.StatusBadRequest)
		return
	}

	// Create the asset row when it does not exist yet, then write the mask.
	if _, err := h.store.GetOrCreateAsset(boardKey, string(body)); err != nil {
		writeBoardPhotoStoreError(w, err)
		return
	}
	if err := h.store.SetManualMask(boardKey, string(body)); err != nil {
		writeBoardPhotoStoreError(w, err)
		return
	}
	writeBoardPhotoJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// PutOverlay imports or replaces the image of one side, together with an
// optional calibration in the multipart "calibration" field.
func (h *BoardPhotoAssetsHandler) PutOverlay(w http.ResponseWriter, r *http.Request) {
	boardKey := r.PathValue("boardKey")
	side := r.PathValue("side")
	if !validBoardPhotoSide(side) {
		http.Error(w, `{"error":"side must be top or bottom"}`, http.StatusBadRequest)
		return
	}
	if err := boardphotos.ValidateBoardKey(boardKey); err != nil {
		http.Error(w, boardPhotoErrorBody(err), http.StatusBadRequest)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxOverlayUploadBytes)
	file, header, err := r.FormFile("image")
	if err != nil {
		writeBoardPhotoMultipartError(w, err)
		return
	}
	defer r.MultipartForm.RemoveAll()
	defer file.Close()

	calibration, err := readBoardPhotoCalibrationField(r)
	if err != nil {
		if errors.Is(err, errBoardPhotoCalibrationTooLarge) {
			http.Error(w, `{"error":"calibration payload too large"}`, http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, boardPhotoErrorBody(err), http.StatusBadRequest)
		}
		return
	}

	// The browser may send "application/octet-stream" for local files, so
	// only pass declared MIME types the image pipeline can compare
	// meaningfully (image/*); anything else is left empty and the real
	// format is decided by the bytes.
	declaredMIME := strings.TrimSpace(header.Header.Get("Content-Type"))
	if declaredMIME != "" && strings.HasPrefix(strings.ToLower(declaredMIME), "image/") {
		if mediaType, _, parseErr := mime.ParseMediaType(declaredMIME); parseErr == nil {
			declaredMIME = mediaType
		}
	} else {
		declaredMIME = ""
	}
	if err := h.service.ImportOverlay(boardKey, side, file, declaredMIME, calibration); err != nil {
		writeBoardPhotoImportError(w, err)
		return
	}

	// Re-read the freshly written row so the response matches the wire
	// format of GET exactly.
	ov, err := h.store.GetOverlay(boardKey, side)
	if err != nil {
		http.Error(w, `{"error":"failed to read overlay after import"}`, http.StatusInternalServerError)
		return
	}
	writeBoardPhotoJSON(w, http.StatusOK, boardPhotoStoredOverlayJSON(ov))
}

// PutCalibration updates only the calibration of an existing overlay.
func (h *BoardPhotoAssetsHandler) PutCalibration(w http.ResponseWriter, r *http.Request) {
	boardKey := r.PathValue("boardKey")
	side := r.PathValue("side")
	if !validBoardPhotoSide(side) {
		http.Error(w, `{"error":"side must be top or bottom"}`, http.StatusBadRequest)
		return
	}
	if err := boardphotos.ValidateBoardKey(boardKey); err != nil {
		http.Error(w, boardPhotoErrorBody(err), http.StatusBadRequest)
		return
	}
	body, ok := readBoardPhotoJSONBody(w, r, maxCalibrationJSONBytes, "calibration")
	if !ok {
		return
	}
	if err := validateBoardPhotoCalibration(body); err != nil {
		http.Error(w, boardPhotoErrorBody(err), http.StatusBadRequest)
		return
	}
	if err := h.service.UpdateCalibration(boardKey, side, string(body)); err != nil {
		writeBoardPhotoStoreError(w, err)
		return
	}
	writeBoardPhotoJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DeleteOverlay removes the overlay of one side (metadata + files).
func (h *BoardPhotoAssetsHandler) DeleteOverlay(w http.ResponseWriter, r *http.Request) {
	boardKey := r.PathValue("boardKey")
	side := r.PathValue("side")
	if !validBoardPhotoSide(side) {
		http.Error(w, `{"error":"side must be top or bottom"}`, http.StatusBadRequest)
		return
	}
	if err := boardphotos.ValidateBoardKey(boardKey); err != nil {
		http.Error(w, boardPhotoErrorBody(err), http.StatusBadRequest)
		return
	}
	if err := h.service.DeleteOverlay(boardKey, side); err != nil {
		if errors.Is(err, boardphotos.ErrNotFound) {
			http.Error(w, `{"error":"overlay not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"failed to delete overlay"}`, http.StatusInternalServerError)
		return
	}
	writeBoardPhotoJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// GetImage serves the private source or render image of one side. The
// service resolves the canonical path; the handler only adds the right
// content type and streams the file.
func (h *BoardPhotoAssetsHandler) GetImage(w http.ResponseWriter, r *http.Request) {
	boardKey := r.PathValue("boardKey")
	side := r.PathValue("side")
	kind := r.PathValue("kind")
	if !validBoardPhotoSide(side) || !validBoardPhotoKind(kind) {
		http.Error(w, `{"error":"invalid side or variant"}`, http.StatusBadRequest)
		return
	}

	// The metadata row carries the real image MIME type (source and render
	// are always written in the same format) and tells us whether the side
	// has an overlay at all.
	ov, err := h.store.GetOverlay(boardKey, side)
	if errors.Is(err, boardphotos.ErrNotFound) {
		http.Error(w, `{"error":"image not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"failed to read overlay"}`, http.StatusInternalServerError)
		return
	}

	f, err := h.service.OpenImage(boardKey, side, kind)
	if err != nil {
		// Missing file or unexpected stored path: never leak internals.
		http.Error(w, `{"error":"image not found"}`, http.StatusNotFound)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		http.Error(w, `{"error":"failed to read image"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", ov.SourceMIME)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

// boardPhotoStoredOverlayJSON builds the wire format for one overlay row.
func boardPhotoStoredOverlayJSON(ov *boardphotos.Overlay) BoardPhotoStoredOverlay {
	return BoardPhotoStoredOverlay{
		Metadata: BoardPhotoOverlayMetadata{
			ID:       ov.AssetID,
			MimeType: ov.SourceMIME,
			WidthPx:  ov.RenderWidth,
			HeightPx: ov.RenderHeight,
		},
		Calibration: boardPhotoCalibrationJSON(ov.Calibration),
	}
}

// boardPhotoCalibrationJSON maps the stored calibration string to the wire
// format: null when empty, the raw JSON otherwise.
func boardPhotoCalibrationJSON(stored string) json.RawMessage {
	if stored == "" {
		return nil
	}
	return json.RawMessage(stored)
}

// readBoardPhotoJSONBody reads and enforces the size cap on a JSON body.
// Returns ok=false after writing the error response.
func readBoardPhotoJSONBody(w http.ResponseWriter, r *http.Request, maxBytes int64, field string) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			http.Error(w, `{"error":"payload too large"}`, http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, `{"error":"failed to read request body"}`, http.StatusBadRequest)
		}
		return nil, false
	}
	if len(body) == 0 {
		http.Error(w, fmt.Sprintf(`{"error":"missing %s"}`, field), http.StatusBadRequest)
		return nil, false
	}
	return body, true
}

// readBoardPhotoCalibrationField reads the optional multipart field
// "calibration" (empty string when absent). A present but non-empty field
// must be valid JSON.
func readBoardPhotoCalibrationField(r *http.Request) (string, error) {
	values := r.MultipartForm.Value["calibration"]
	if len(values) == 0 || values[0] == "" {
		return "", nil
	}
	if len(values[0]) > maxCalibrationJSONBytes {
		return "", errBoardPhotoCalibrationTooLarge
	}
	if !json.Valid([]byte(values[0])) {
		return "", fmt.Errorf("%w: calibration is not valid JSON", errInvalidBoardPhotoJSON)
	}
	return values[0], nil
}

// validBoardPhotoSide accepts only the two known sides.
func validBoardPhotoSide(side string) bool {
	return side == boardphotos.SideTop || side == boardphotos.SideBottom
}

// validBoardPhotoKind accepts only the two known file kinds.
func validBoardPhotoKind(kind string) bool {
	return kind == boardphotos.KindSource || kind == boardphotos.KindRender
}

// boardPhotoErrorBody renders an error as the JSON error body the client
// already knows how to read.
func boardPhotoErrorBody(err error) string {
	return fmt.Sprintf(`{"error":%q}`, err.Error())
}

// writeBoardPhotoJSON writes v as a JSON response with the given status.
func writeBoardPhotoJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeBoardPhotoStoreError maps store/service errors to status codes.
func writeBoardPhotoStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, boardphotos.ErrInvalidBoardKey) {
		http.Error(w, boardPhotoErrorBody(err), http.StatusBadRequest)
		return
	}
	if errors.Is(err, boardphotos.ErrNotFound) {
		http.Error(w, `{"error":"asset or overlay not found"}`, http.StatusNotFound)
		return
	}
	http.Error(w, `{"error":"failed to write asset"}`, http.StatusInternalServerError)
}

// writeBoardPhotoMultipartError maps multipart parsing failures to codes.
func writeBoardPhotoMultipartError(w http.ResponseWriter, err error) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		http.Error(w, `{"error":"image exceeds the 50 MiB limit"}`, http.StatusRequestEntityTooLarge)
		return
	}
	http.Error(w, `{"error":"failed to parse multipart form"}`, http.StatusBadRequest)
}

// writeBoardPhotoImportError maps ImportOverlay errors to status codes.
func writeBoardPhotoImportError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, boardphotos.ErrTooLargeBytes),
		errors.Is(err, boardphotos.ErrTooManyPixels),
		errors.Is(err, boardphotos.ErrAxisTooLarge):
		http.Error(w, `{"error":"image exceeds the size limits"}`, http.StatusRequestEntityTooLarge)
	case errors.Is(err, boardphotos.ErrNotJPEGPNG):
		http.Error(w, `{"error":"only JPEG and PNG images are accepted"}`, http.StatusUnsupportedMediaType)
	case errors.Is(err, boardphotos.ErrMIMEMismatch):
		http.Error(w, `{"error":"declared MIME type does not match image data"}`, http.StatusUnsupportedMediaType)
	case errors.Is(err, boardphotos.ErrNotFound):
		http.Error(w, `{"error":"asset not found"}`, http.StatusNotFound)
	case errors.Is(err, boardphotos.ErrInvalidBoardKey):
		http.Error(w, boardPhotoErrorBody(err), http.StatusBadRequest)
	default:
		http.Error(w, `{"error":"failed to import overlay"}`, http.StatusInternalServerError)
	}
}
