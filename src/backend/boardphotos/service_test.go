package boardphotos_test

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"boardripper/boardphotos"
	"boardripper/databank"
)

// newService opens a databank in a temp dir and a Service whose overlays
// root is a sibling directory, mirroring the DATA_DIR layout. The db handle
// is returned so tests can inspect or tamper with raw rows.
func newService(t *testing.T) (svc *boardphotos.Service, st *boardphotos.Store, db *databank.DB, root string) {
	t.Helper()
	dataDir := t.TempDir()
	d, err := databank.Open(dataDir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	st = boardphotos.NewStore(d)
	root = filepath.Join(dataDir, "board-overlays")
	return boardphotos.NewService(st, root), st, d, root
}

// assetDir returns the on-disk directory for a board key's asset.
func assetDir(t *testing.T, st *boardphotos.Store, root, key string) string {
	t.Helper()
	asset, err := st.GetOrCreateAsset(key, "")
	if err != nil {
		t.Fatalf("GetOrCreateAsset: %v", err)
	}
	return filepath.Join(root, asset.ID)
}

func smallPNG(t *testing.T, w, h int, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func smallJPEG(t *testing.T, w, h int, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode jpeg: %v", err)
	}
	return buf.Bytes()
}

// storedBytes maps every file below root (relative path) to its content.
func storedBytes(t *testing.T, root string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		out[rel] = data
		return nil
	})
	if err != nil {
		t.Fatalf("walk overlays root: %v", err)
	}
	return out
}

func assertOverlay(t *testing.T, st *boardphotos.Store, key, side, mime string) *boardphotos.Overlay {
	t.Helper()
	ov, err := st.GetOverlay(key, side)
	if err != nil {
		t.Fatalf("GetOverlay %s: %v", side, err)
	}
	if ov.SourceMIME != mime || ov.SourceSize <= 0 {
		t.Errorf("overlay meta wrong: %+v", ov)
	}
	if ov.RenderWidth <= 0 || ov.RenderHeight <= 0 {
		t.Errorf("render size not stored: %+v", ov)
	}
	return ov
}

func TestService_ImportCreatesOverlay(t *testing.T) {
	svc, st, _, root := newService(t)
	key := "abc123#0"
	data := smallPNG(t, 40, 30, color.RGBA{10, 20, 30, 255})

	if err := svc.ImportOverlay(key, "top", bytes.NewReader(data), "image/png", ""); err != nil {
		t.Fatalf("ImportOverlay: %v", err)
	}
	ov := assertOverlay(t, st, key, "top", "image/png")
	if filepath.IsAbs(ov.SourcePath) {
		t.Errorf("SourcePath should be relative to the overlays root, got %q", ov.SourcePath)
	}
	if filepath.Base(filepath.Dir(ov.SourcePath)) != ov.AssetID {
		t.Errorf("SourcePath %q not under asset id %q", ov.SourcePath, ov.AssetID)
	}

	// Both files exist on disk and the source decodes with full size.
	src, err := svc.OpenImage(key, "top", boardphotos.KindSource)
	if err != nil {
		t.Fatalf("OpenImage source: %v", err)
	}
	img, err := png.Decode(src)
	src.Close()
	if err != nil {
		t.Fatalf("stored source does not decode: %v", err)
	}
	if got := img.Bounds(); got.Dx() != 40 || got.Dy() != 30 {
		t.Errorf("stored source is %dx%d, want 40x30", got.Dx(), got.Dy())
	}
	if _, err := svc.OpenImage(key, "top", boardphotos.KindRender); err != nil {
		t.Fatalf("OpenImage render: %v", err)
	}

	// The asset dir holds exactly source and render, no leftovers.
	entries, err := os.ReadDir(filepath.Join(root, ov.AssetID))
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("asset dir has %d entries, want 2: %v", len(entries), entries)
	}
}

func TestService_ReplaceSucceeds(t *testing.T) {
	svc, st, _, root := newService(t)
	key := "abc123#0"
	first := smallPNG(t, 40, 30, color.RGBA{1, 2, 3, 255})
	second := smallPNG(t, 20, 10, color.RGBA{9, 9, 9, 255})

	if err := svc.ImportOverlay(key, "top", bytes.NewReader(first), "image/png", ""); err != nil {
		t.Fatalf("first import: %v", err)
	}
	if err := svc.UpdateCalibration(key, "top", `{"version":1}`); err != nil {
		t.Fatalf("UpdateCalibration: %v", err)
	}
	before := assertOverlay(t, st, key, "top", "image/png")

	if err := svc.ImportOverlay(key, "top", bytes.NewReader(second), "image/png", ""); err != nil {
		t.Fatalf("replace: %v", err)
	}
	after := assertOverlay(t, st, key, "top", "image/png")
	// The canonical file name is stable per asset and side; the content and
	// the recorded size must change instead.
	if after.SourcePath != before.SourcePath {
		t.Errorf("replace changed the canonical path: %q vs %q", before.SourcePath, after.SourcePath)
	}
	if after.SourceSize >= before.SourceSize {
		t.Errorf("SourceSize did not change: before=%d after=%d", before.SourceSize, after.SourceSize)
	}
	if after.RenderWidth == before.RenderWidth || after.RenderHeight == before.RenderHeight {
		t.Errorf("render size did not change: %dx%d vs %dx%d",
			before.RenderWidth, before.RenderHeight, after.RenderWidth, after.RenderHeight)
	}
	if after.Calibration == "" {
		t.Error("empty calibration on replace wiped the existing calibration")
	}

	img, err := svc.OpenImage(key, "top", boardphotos.KindSource)
	if err != nil {
		t.Fatalf("open replaced source: %v", err)
	}
	decoded, err := png.Decode(img)
	img.Close()
	if err != nil {
		t.Fatalf("decode replaced source: %v", err)
	}
	if got := decoded.Bounds(); got.Dx() != 20 || got.Dy() != 10 {
		t.Errorf("replaced source is %dx%d, want 20x10", got.Dx(), got.Dy())
	}

	// Only the two current files remain: no backups, no staging leftovers.
	entries, err := os.ReadDir(assetDir(t, st, root, key))
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("asset dir has %d entries after replace, want 2: %v", len(entries), entries)
	}
}

func TestService_FailedReplacePreservesEverything(t *testing.T) {
	svc, st, _, _ := newService(t)
	key := "abc123#0"
	first := smallPNG(t, 40, 30, color.RGBA{5, 5, 5, 255})
	if err := svc.ImportOverlay(key, "top", bytes.NewReader(first), "image/png", ""); err != nil {
		t.Fatalf("import: %v", err)
	}
	if err := svc.UpdateCalibration(key, "top", `{"version":1,"pairs":[]}`); err != nil {
		t.Fatalf("UpdateCalibration: %v", err)
	}
	ovBefore, err := st.GetOverlay(key, "top")
	if err != nil {
		t.Fatalf("GetOverlay: %v", err)
	}
	filesBefore := storedBytes(t, svc.Root())
	if len(filesBefore) != 2 {
		t.Fatalf("expected 2 stored files, got %d", len(filesBefore))
	}

	if err := svc.ImportOverlay(key, "top", bytes.NewReader([]byte("not an image")), "", ""); err == nil {
		t.Fatal("import of invalid image should fail")
	}
	ovAfter, err := st.GetOverlay(key, "top")
	if err != nil {
		t.Fatalf("GetOverlay after failed import: %v", err)
	}
	if *ovAfter != *ovBefore {
		t.Errorf("overlay row changed on failed import: got %+v want %+v", ovAfter, ovBefore)
	}
	if got := storedBytes(t, svc.Root()); !bytesEqualMap(got, filesBefore) {
		t.Errorf("files changed on failed import: %v vs %v", keys(got), keys(filesBefore))
	}
}

func TestService_FailedFirstImportLeavesNoAsset(t *testing.T) {
	svc, st, _, root := newService(t)
	key := "new-board#0"

	if err := svc.ImportOverlay(key, "top", bytes.NewBufferString("not an image"), "", ""); err == nil {
		t.Fatal("invalid first import should fail")
	}
	if _, err := st.GetAsset(key); err != boardphotos.ErrNotFound {
		t.Fatalf("failed first import left an asset: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read overlays root: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("failed first import left files: %v", entries)
	}
}

func TestService_AppRestartLoadsOverlayAndCalibration(t *testing.T) {
	dataDir := t.TempDir()
	root := filepath.Join(dataDir, "board-overlays")
	key := "restart-board#0"
	calibration := `{"version":1,"points":[{"id":1,"board":{"x":0.1,"y":0.1},"photo":{"x":0.2,"y":0.2}}]}`
	imageData := smallJPEG(t, 40, 30, color.RGBA{20, 40, 60, 255})

	db, err := databank.Open(dataDir)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	st := boardphotos.NewStore(db)
	svc := boardphotos.NewService(st, root)
	if err := svc.ImportOverlay(key, "top", bytes.NewReader(imageData), "image/jpeg", calibration); err != nil {
		t.Fatalf("ImportOverlay: %v", err)
	}
	before := storedBytes(t, root)
	if err := db.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}

	// A fresh database and service instance represent an application restart.
	db2, err := databank.Open(dataDir)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer db2.Close()
	st2 := boardphotos.NewStore(db2)
	svc2 := boardphotos.NewService(st2, root)
	ov, err := st2.GetOverlay(key, "top")
	if err != nil {
		t.Fatalf("GetOverlay after restart: %v", err)
	}
	if ov.Calibration != calibration {
		t.Fatalf("calibration after restart = %q, want %q", ov.Calibration, calibration)
	}
	if ov.SourceMIME != "image/jpeg" || ov.RenderWidth != 40 || ov.RenderHeight != 30 {
		t.Fatalf("overlay metadata after restart = %+v", ov)
	}
	for _, kind := range []string{boardphotos.KindSource, boardphotos.KindRender} {
		f, err := svc2.OpenImage(key, "top", kind)
		if err != nil {
			t.Fatalf("OpenImage %s after restart: %v", kind, err)
		}
		if _, err := jpeg.Decode(f); err != nil {
			f.Close()
			t.Fatalf("decode %s after restart: %v", kind, err)
		}
		if err := f.Close(); err != nil {
			t.Fatalf("close %s after restart: %v", kind, err)
		}
	}
	if after := storedBytes(t, root); !bytesEqualMap(after, before) {
		t.Fatalf("restart changed overlay files: before=%v after=%v", keys(before), keys(after))
	}
}

func TestService_IndexResetPreservesOverlayFiles(t *testing.T) {
	dataDir := t.TempDir()
	root := filepath.Join(dataDir, "board-overlays")
	db, err := databank.Open(dataDir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	st := boardphotos.NewStore(db)
	svc := boardphotos.NewService(st, root)
	key := "reset-board#0"
	imageData := smallPNG(t, 40, 30, color.RGBA{80, 90, 100, 255})
	if err := svc.ImportOverlay(key, "top", bytes.NewReader(imageData), "image/png", `{"version":1}`); err != nil {
		t.Fatalf("ImportOverlay top: %v", err)
	}
	if err := svc.ImportOverlay(key, "bottom", bytes.NewReader(imageData), "image/png", ""); err != nil {
		t.Fatalf("ImportOverlay bottom: %v", err)
	}
	before := storedBytes(t, root)

	if err := db.ResetAll(dataDir); err != nil {
		t.Fatalf("ResetAll: %v", err)
	}
	if after := storedBytes(t, root); !bytesEqualMap(after, before) {
		t.Fatalf("index reset changed overlay files: before=%v after=%v", keys(before), keys(after))
	}
	for _, side := range []string{"top", "bottom"} {
		if _, err := st.GetOverlay(key, side); err != nil {
			t.Fatalf("%s overlay after reset: %v", side, err)
		}
		f, err := svc.OpenImage(key, side, boardphotos.KindSource)
		if err != nil {
			t.Fatalf("open %s after reset: %v", side, err)
		}
		f.Close()
	}
}

func TestService_FormatReplacementRemovesObsoleteFiles(t *testing.T) {
	svc, st, _, root := newService(t)
	key := "format-board#0"
	if err := svc.ImportOverlay(key, "top", bytes.NewReader(smallPNG(t, 40, 30, color.RGBA{1, 2, 3, 255})), "image/png", ""); err != nil {
		t.Fatalf("png import: %v", err)
	}
	if err := svc.ImportOverlay(key, "top", bytes.NewReader(smallJPEG(t, 40, 30, color.RGBA{3, 2, 1, 255})), "image/jpeg", ""); err != nil {
		t.Fatalf("jpeg replacement: %v", err)
	}
	asset, err := st.GetAsset(key)
	if err != nil {
		t.Fatalf("get asset: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(root, asset.ID))
	if err != nil {
		t.Fatalf("read asset dir: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("format replacement left obsolete files: %v", entries)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".png") {
			t.Errorf("obsolete PNG remains after JPEG replacement: %s", entry.Name())
		}
	}
}

func TestService_RecalibrationKeepsBytes(t *testing.T) {
	svc, st, _, _ := newService(t)
	key := "abc123#0"
	data := smallPNG(t, 40, 30, color.RGBA{1, 2, 3, 255})
	if err := svc.ImportOverlay(key, "top", bytes.NewReader(data), "image/png", ""); err != nil {
		t.Fatalf("import: %v", err)
	}
	filesBefore := storedBytes(t, svc.Root())

	if err := svc.UpdateCalibration(key, "top", `{"version":2,"pairs":[[0,0],[1,1]]}`); err != nil {
		t.Fatalf("UpdateCalibration: %v", err)
	}
	ov, err := st.GetOverlay(key, "top")
	if err != nil {
		t.Fatalf("GetOverlay: %v", err)
	}
	if ov.Calibration == "" {
		t.Error("calibration not stored")
	}
	if got := storedBytes(t, svc.Root()); !bytesEqualMap(got, filesBefore) {
		t.Errorf("recalibration changed files: %v vs %v", keys(got), keys(filesBefore))
	}

	if err := svc.UpdateCalibration(key, "top", ""); err != nil {
		t.Fatalf("clear calibration: %v", err)
	}
	ov, err = st.GetOverlay(key, "top")
	if err != nil {
		t.Fatalf("GetOverlay after clear: %v", err)
	}
	if ov.Calibration != "" {
		t.Errorf("calibration not cleared: %q", ov.Calibration)
	}
	if got := storedBytes(t, svc.Root()); !bytesEqualMap(got, filesBefore) {
		t.Errorf("clearing calibration changed files")
	}
}

func TestService_DeleteOverlay(t *testing.T) {
	svc, st, _, root := newService(t)
	key := "abc123#0"
	data := smallPNG(t, 40, 30, color.RGBA{1, 2, 3, 255})
	if err := svc.ImportOverlay(key, "top", bytes.NewReader(data), "image/png", ""); err != nil {
		t.Fatalf("import top: %v", err)
	}
	if err := svc.ImportOverlay(key, "bottom", bytes.NewReader(data), "image/png", ""); err != nil {
		t.Fatalf("import bottom: %v", err)
	}

	if err := svc.DeleteOverlay(key, "top"); err != nil {
		t.Fatalf("DeleteOverlay top: %v", err)
	}
	if _, err := st.GetOverlay(key, "top"); err != boardphotos.ErrNotFound {
		t.Errorf("GetOverlay after delete = %v, want ErrNotFound", err)
	}
	dir := assetDir(t, st, root, key)
	for _, name := range []string{"top.source.png", "top.render.png", "top.source.png.bak", "top.render.png.bak"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			t.Errorf("file %s still present after delete", name)
		}
	}
	if _, err := svc.OpenImage(key, "bottom", boardphotos.KindSource); err != nil {
		t.Errorf("bottom side damaged by top delete: %v", err)
	}

	if err := svc.DeleteOverlay(key, "top"); err != boardphotos.ErrNotFound {
		t.Errorf("second DeleteOverlay = %v, want ErrNotFound", err)
	}

	// Deleting an overlay whose render file was removed externally still
	// works: missing files are tolerated.
	if err := os.Remove(filepath.Join(dir, "bottom.render.png")); err != nil {
		t.Fatalf("remove render file externally: %v", err)
	}
	if err := svc.DeleteOverlay(key, "bottom"); err != nil {
		t.Fatalf("DeleteOverlay bottom with missing render file: %v", err)
	}
	if _, err := st.GetOverlay(key, "bottom"); err != boardphotos.ErrNotFound {
		t.Errorf("GetOverlay after bottom delete = %v, want ErrNotFound", err)
	}
}

func TestService_PathSafety(t *testing.T) {
	svc, _, db, _ := newService(t)
	key := "abc123#0"
	data := smallPNG(t, 8, 8, color.RGBA{1, 2, 3, 255})
	if err := svc.ImportOverlay(key, "top", bytes.NewReader(data), "image/png", ""); err != nil {
		t.Fatalf("import: %v", err)
	}

	for _, evil := range []string{
		"../../evil.png",
		"/etc/passwd",
		"abc123#0/top.source.png",
		"abc123/top.source.txt",
		"other/top.source.png",
		"abc123/bottom.source.png",
	} {
		if _, err := db.Conn().Exec(`UPDATE board_photo_overlays SET source_path = ?`, evil); err != nil {
			t.Fatalf("tamper with source_path: %v", err)
		}
		if _, err := svc.ResolveImage(key, "top", boardphotos.KindSource); err == nil {
			t.Errorf("ResolveImage accepted tampered path %q", evil)
		}
	}

	if _, err := svc.ResolveImage(key, "top", "thumbnail"); err == nil {
		t.Error("ResolveImage accepted invalid kind")
	}
	if _, err := svc.ResolveImage(key, "TOP", boardphotos.KindSource); err == nil {
		t.Error("ResolveImage accepted uppercase side")
	}

	// Reimport restores a valid row; the honest path resolves and opens.
	if err := svc.ImportOverlay(key, "top", bytes.NewReader(data), "image/png", ""); err != nil {
		t.Fatalf("reimport: %v", err)
	}
	path, err := svc.ResolveImage(key, "top", boardphotos.KindSource)
	if err != nil {
		t.Fatalf("ResolveImage: %v", err)
	}
	if !strings.HasPrefix(path, svc.Root()+string(filepath.Separator)) {
		t.Errorf("resolved path %q not under root %q", path, svc.Root())
	}
	f, err := svc.OpenImage(key, "top", boardphotos.KindSource)
	if err != nil {
		t.Fatalf("OpenImage: %v", err)
	}
	f.Close()
}

func TestService_SidesAreIndependent(t *testing.T) {
	svc, st, _, _ := newService(t)
	key := "abc123#0"
	red := smallPNG(t, 40, 30, color.RGBA{255, 0, 0, 255})
	blue := smallPNG(t, 80, 20, color.RGBA{0, 0, 255, 255})

	if err := svc.ImportOverlay(key, "top", bytes.NewReader(red), "image/png", ""); err != nil {
		t.Fatalf("import top: %v", err)
	}
	if err := svc.ImportOverlay(key, "bottom", bytes.NewReader(blue), "image/png", `{"side":"bottom"}`); err != nil {
		t.Fatalf("import bottom: %v", err)
	}

	top, err := st.GetOverlay(key, "top")
	if err != nil {
		t.Fatalf("GetOverlay top: %v", err)
	}
	bottom, err := st.GetOverlay(key, "bottom")
	if err != nil {
		t.Fatalf("GetOverlay bottom: %v", err)
	}
	if top.SourcePath == bottom.SourcePath {
		t.Error("top and bottom share one source path")
	}
	if bottom.Calibration != `{"side":"bottom"}` {
		t.Errorf("bottom calibration = %q", bottom.Calibration)
	}
	if top.Calibration != "" {
		t.Errorf("top calibration = %q, want empty", top.Calibration)
	}

	// Replace top only; every bottom file stays byte-identical.
	filesBefore := storedBytes(t, svc.Root())
	green := smallPNG(t, 10, 10, color.RGBA{0, 255, 0, 255})
	if err := svc.ImportOverlay(key, "top", bytes.NewReader(green), "image/png", ""); err != nil {
		t.Fatalf("replace top: %v", err)
	}
	filesAfter := storedBytes(t, svc.Root())
	for name, data := range filesBefore {
		if strings.HasPrefix(filepath.Base(name), "top.") {
			continue
		}
		if !bytesEqual(filesAfter[name], data) {
			t.Errorf("file %s changed during top replace", name)
		}
	}

	// Replacing bottom with an empty calibration keeps its calibration.
	if err := svc.ImportOverlay(key, "bottom", bytes.NewReader(blue), "image/png", ""); err != nil {
		t.Fatalf("replace bottom: %v", err)
	}
	bottom, err = st.GetOverlay(key, "bottom")
	if err != nil {
		t.Fatalf("GetOverlay bottom after replace: %v", err)
	}
	if bottom.Calibration != `{"side":"bottom"}` {
		t.Errorf("bottom calibration lost on replace: %q", bottom.Calibration)
	}
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func bytesEqualMap(a, b map[string][]byte) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if !bytesEqual(b[k], v) {
			return false
		}
	}
	return true
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
