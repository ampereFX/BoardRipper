package boardphotos_test

import (
	"sync"
	"testing"

	"boardripper/boardphotos"
	"boardripper/databank"
)

// stageV11 produces a database in the exact state of a pre-photo install:
// fresh schema with the two photo tables dropped and schema_version set to
// 11, then closed so the next Open walks the real v11 -> v12 upgrade path.
func stageV11(t *testing.T) string {
	t.Helper()
	dataDir := t.TempDir()
	db, err := databank.Open(dataDir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	for _, tbl := range []string{"board_photo_overlays", "board_photo_assets"} {
		if _, err := db.Writer().Exec(`DROP TABLE ` + tbl); err != nil {
			t.Fatalf("drop %s: %v", tbl, err)
		}
	}
	if _, err := db.Writer().Exec(`DELETE FROM schema_version`); err != nil {
		t.Fatalf("clear schema_version: %v", err)
	}
	if _, err := db.Writer().Exec(`INSERT INTO schema_version (version) VALUES (11)`); err != nil {
		t.Fatalf("set version=11: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	return dataDir
}

func tableExists(t *testing.T, db *databank.DB, name string) bool {
	t.Helper()
	var n string
	err := db.Conn().QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name).Scan(&n)
	return err == nil
}

func TestMigrateV11ToV12_CreatesTables(t *testing.T) {
	dataDir := stageV11(t)

	db, err := databank.Open(dataDir)
	if err != nil {
		t.Fatalf("Open after downgrade: %v", err)
	}
	defer db.Close()

	for _, tbl := range []string{"board_photo_assets", "board_photo_overlays"} {
		if !tableExists(t, db, tbl) {
			t.Errorf("table %q missing after v11->v12 migration", tbl)
		}
	}
	var ver int
	if err := db.Conn().QueryRow(`SELECT version FROM schema_version LIMIT 1`).Scan(&ver); err != nil {
		t.Fatalf("read schema_version: %v", err)
	}
	if ver != 12 {
		t.Errorf("schema version = %d, want 12", ver)
	}
}

func TestOpen_IdempotentWithPhotoTables(t *testing.T) {
	dataDir := stageV11(t)

	db, err := databank.Open(dataDir)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	st := boardphotos.NewStore(db)
	asset, err := st.GetOrCreateAsset("abc123#0", "")
	if err != nil {
		t.Fatalf("GetOrCreateAsset: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	db2, err := databank.Open(dataDir)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer db2.Close()
	st2 := boardphotos.NewStore(db2)
	got, err := st2.GetAsset("abc123#0")
	if err != nil {
		t.Fatalf("GetAsset after reopen: %v", err)
	}
	if got.ID != asset.ID {
		t.Errorf("asset id changed across reopen: %q -> %q", asset.ID, got.ID)
	}
}

func TestStore_CRUD(t *testing.T) {
	db, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	st := boardphotos.NewStore(db)

	key := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef#2"

	// Get on an unknown key is an empty result, not an error.
	if _, err := st.GetAsset(key); err != boardphotos.ErrNotFound {
		t.Errorf("GetAsset unknown = %v, want ErrNotFound", err)
	}

	mask := `{"side":"top","polygon":[{"x":0,"y":0},{"x":1,"y":0},{"x":1,"y":1}]}`
	asset, err := st.GetOrCreateAsset(key, mask)
	if err != nil {
		t.Fatalf("GetOrCreateAsset: %v", err)
	}
	if len(asset.ID) != 36 || asset.ID[14] != '4' {
		t.Errorf("asset id %q is not a v4 UUID", asset.ID)
	}
	if asset.GeometryFingerprint != "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" || asset.OccurrenceIndex != 2 {
		t.Errorf("asset split wrong: fp=%q idx=%d", asset.GeometryFingerprint, asset.OccurrenceIndex)
	}
	if asset.ManualMask != mask {
		t.Errorf("manual mask not stored: %q", asset.ManualMask)
	}

	// Get-or-create is idempotent and never duplicates the row.
	again, err := st.GetOrCreateAsset(key, "")
	if err != nil {
		t.Fatalf("GetOrCreateAsset again: %v", err)
	}
	if again.ID != asset.ID || again.ManualMask != mask {
		t.Errorf("second GetOrCreateAsset changed the row: %+v", again)
	}

	// A different occurrence index is a different asset.
	if _, err := st.GetOrCreateAsset("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef#3", ""); err != nil {
		t.Fatalf("GetOrCreateAsset #3: %v", err)
	}

	// Overlay upsert: insert then update through the same call.
	meta := boardphotos.OverlayMeta{SourcePath: "photos/board-top.jpg", SourceMIME: "image/jpeg", SourceSize: 1234}
	if err := st.UpsertOverlay(key, "top", meta, ""); err != nil {
		t.Fatalf("UpsertOverlay insert: %v", err)
	}
	ov, err := st.GetOverlay(key, "top")
	if err != nil {
		t.Fatalf("GetOverlay: %v", err)
	}
	if ov.AssetID != asset.ID || ov.SourcePath != meta.SourcePath || ov.SourceSize != 1234 {
		t.Errorf("overlay insert wrong: %+v", ov)
	}
	if ov.Calibration != "" {
		t.Errorf("calibration should start empty, got %q", ov.Calibration)
	}

	meta2 := boardphotos.OverlayMeta{SourcePath: "photos/board-top-2.jpg", SourceMIME: "image/jpeg", SourceSize: 999, RenderPath: "render/board-top.webp", RenderWidth: 800, RenderHeight: 600}
	if err := st.UpsertOverlay(key, "top", meta2, ""); err != nil {
		t.Fatalf("UpsertOverlay update: %v", err)
	}
	ov2, err := st.GetOverlay(key, "top")
	if err != nil {
		t.Fatalf("GetOverlay after update: %v", err)
	}
	if ov2.SourcePath != meta2.SourcePath || ov2.RenderWidth != 800 || !ov2.CreatedAt.Equal(ov.CreatedAt) {
		t.Errorf("overlay update wrong: created=%v now=%v meta=%+v", ov.CreatedAt, ov2.CreatedAt, ov2)
	}

	// Upsert with empty calibration must not wipe an existing one.
	if err := st.UpdateCalibration(key, "top", `{"version":1,"pairs":[]}`); err != nil {
		t.Fatalf("UpdateCalibration: %v", err)
	}
	if err := st.UpsertOverlay(key, "top", meta2, ""); err != nil {
		t.Fatalf("UpsertOverlay after calibration: %v", err)
	}
	ov3, err := st.GetOverlay(key, "top")
	if err != nil {
		t.Fatalf("GetOverlay after upsert: %v", err)
	}
	if ov3.Calibration == "" {
		t.Error("upsert with empty calibration wiped existing calibration")
	}

	// UpdateCalibration with empty string clears it.
	if err := st.UpdateCalibration(key, "top", ""); err != nil {
		t.Fatalf("UpdateCalibration clear: %v", err)
	}
	ov4, err := st.GetOverlay(key, "top")
	if err != nil {
		t.Fatalf("GetOverlay after clear: %v", err)
	}
	if ov4.Calibration != "" {
		t.Errorf("calibration not cleared: %q", ov4.Calibration)
	}

	// Sides are independent rows.
	if err := st.UpsertOverlay(key, "bottom", boardphotos.OverlayMeta{SourcePath: "photos/board-bottom.jpg"}, ""); err != nil {
		t.Fatalf("UpsertOverlay bottom: %v", err)
	}
	if _, err := st.GetOverlay(key, "bottom"); err != nil {
		t.Fatalf("GetOverlay bottom: %v", err)
	}

	// DeleteSide removes only that side.
	if err := st.DeleteSide(key, "bottom"); err != nil {
		t.Fatalf("DeleteSide: %v", err)
	}
	if _, err := st.GetOverlay(key, "bottom"); err != boardphotos.ErrNotFound {
		t.Errorf("GetOverlay after delete = %v, want ErrNotFound", err)
	}
	if _, err := st.GetOverlay(key, "top"); err != nil {
		t.Errorf("top side should survive bottom delete: %v", err)
	}
	if err := st.DeleteSide(key, "bottom"); err != boardphotos.ErrNotFound {
		t.Errorf("second DeleteSide = %v, want ErrNotFound", err)
	}
}

func TestStore_GetOrCreateAssetConcurrent(t *testing.T) {
	db, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	st := boardphotos.NewStore(db)

	const workers = 16
	results := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := st.GetOrCreateAsset("concurrent#0", "")
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Errorf("concurrent GetOrCreateAsset: %v", err)
		}
	}
}

func TestStore_Validation(t *testing.T) {
	db, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	st := boardphotos.NewStore(db)

	// Malformed board keys.
	for _, key := range []string{"", "nohash", "fp#-1", "fp#x", "fp#", "#3"} {
		if _, err := st.GetOrCreateAsset(key, ""); err == nil {
			t.Errorf("GetOrCreateAsset(%q) should fail", key)
		}
	}

	// Strict side check; the DB CHECK constraint would also reject these.
	key := "fp#0"
	if _, err := st.GetOrCreateAsset(key, ""); err != nil {
		t.Fatalf("GetOrCreateAsset: %v", err)
	}
	if err := st.UpsertOverlay(key, "left", boardphotos.OverlayMeta{}, ""); err == nil {
		t.Error("UpsertOverlay side=left should fail")
	}
	if _, err := st.GetOverlay(key, "TOP"); err == nil {
		t.Error("GetOverlay side=TOP should fail (strict lowercase)")
	}

	// Invalid JSON payloads.
	if err := st.SetManualMask(key, "{not json"); err == nil {
		t.Error("SetManualMask invalid JSON should fail")
	}
	if _, err := st.GetOrCreateAsset("fp2#0", "[broken"); err == nil {
		t.Error("GetOrCreateAsset invalid mask JSON should fail")
	}
	if err := st.UpsertOverlay(key, "top", boardphotos.OverlayMeta{SourcePath: "x"}, "{bad"); err == nil {
		t.Error("UpsertOverlay invalid calibration JSON should fail")
	}

	// Overlay operations on an unknown board key.
	if err := st.UpsertOverlay("ghost#0", "top", boardphotos.OverlayMeta{SourcePath: "x"}, ""); err != boardphotos.ErrNotFound {
		t.Errorf("UpsertOverlay unknown asset = %v, want ErrNotFound", err)
	}
	if err := st.UpdateCalibration("ghost#0", "top", "{}"); err != boardphotos.ErrNotFound {
		t.Errorf("UpdateCalibration unknown asset = %v, want ErrNotFound", err)
	}
}

func TestStore_SurvivesIndexReset(t *testing.T) {
	dataDir := t.TempDir()
	db, err := databank.Open(dataDir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	st := boardphotos.NewStore(db)

	key := "keepme#0"
	if _, err := st.GetOrCreateAsset(key, ""); err != nil {
		t.Fatalf("GetOrCreateAsset: %v", err)
	}
	if err := st.UpsertOverlay(key, "top", boardphotos.OverlayMeta{SourcePath: "p.jpg"}, ""); err != nil {
		t.Fatalf("UpsertOverlay: %v", err)
	}

	if err := db.ResetAll(dataDir); err != nil {
		t.Fatalf("ResetAll: %v", err)
	}

	// ResetAll wipes scan state (bindings/files) but must keep photo data.
	if _, err := st.GetAsset(key); err != nil {
		t.Errorf("asset lost after ResetAll: %v", err)
	}
	if _, err := st.GetOverlay(key, "top"); err != nil {
		t.Errorf("overlay lost after ResetAll: %v", err)
	}
}
