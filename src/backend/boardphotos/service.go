package boardphotos

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// File kinds accepted by ResolveImage and OpenImage.
const (
	KindSource = "source"
	KindRender = "render"
)

// Service installs overlay image files and keeps the matching metadata in
// sync. Files live under a configurable root, productively
// DATA_DIR/board-overlays. Final paths are always built from the internal
// asset ID and the side, never from caller-provided strings, and the
// metadata row is committed in the same SQLite transaction that brackets
// the file swap, so a failed import or replace leaves the previous overlay
// row and its files completely unchanged.
type Service struct {
	store *Store
	root  string
}

// NewService returns a service that stores its files under root.
func NewService(store *Store, root string) *Service {
	return &Service{store: store, root: root}
}

// Root returns the configured overlays root directory.
func (s *Service) Root() string { return s.root }

// ImportOverlay installs or replaces the overlay for one side of an asset,
// creating the asset when needed. The image is decoded, cleaned and
// re-encoded into a staging directory under the root; source and render
// files are then swapped in atomically (old files backed up first) and the
// metadata row is committed only after both installs succeeded. On any
// failure the previous row and files stay untouched. calibration may be
// empty, which keeps an existing calibration.
func (s *Service) ImportOverlay(boardKey, side string, r io.Reader, declaredMIME, calibration string) error {
	if err := ValidateBoardKey(boardKey); err != nil {
		return err
	}
	if err := validateSide(side); err != nil {
		return err
	}
	if err := validateJSON("calibration", calibration); err != nil {
		return err
	}

	if err := os.MkdirAll(s.root, 0o755); err != nil {
		return fmt.Errorf("boardphotos: create overlays root: %w", err)
	}

	// Decode and clean on the same volume as the final files, so the
	// installs below are same-filesystem renames.
	staging, err := os.MkdirTemp(s.root, "staging-*")
	if err != nil {
		return fmt.Errorf("boardphotos: create staging dir: %w", err)
	}
	defer os.RemoveAll(staging)

	proc, err := Process(r, declaredMIME, staging)
	if err != nil {
		return err
	}
	ext, err := extFor(proc.SourceMIME)
	if err != nil {
		return err
	}

	tx, err := s.store.db.Writer().Begin()
	if err != nil {
		removeStaged(proc.SourcePath, proc.RenderPath)
		return fmt.Errorf("boardphotos: begin tx: %w", err)
	}
	defer tx.Rollback()
	asset, created, err := s.store.getOrCreateAssetTx(tx, boardKey, "")
	if err != nil {
		tx.Rollback()
		removeStaged(proc.SourcePath, proc.RenderPath)
		return err
	}
	assetDir := filepath.Join(s.root, asset.ID)
	if err := os.MkdirAll(assetDir, 0o755); err != nil {
		tx.Rollback()
		removeStaged(proc.SourcePath, proc.RenderPath)
		if created {
			_ = os.Remove(assetDir)
		}
		return fmt.Errorf("boardphotos: create overlay dir: %w", err)
	}
	srcTarget := filepath.Join(assetDir, side+".source"+ext)
	renderTarget := filepath.Join(assetDir, side+".render"+ext)
	srcNew, renderNew := srcTarget+".new", renderTarget+".new"
	if err := os.Rename(proc.SourcePath, srcNew); err != nil {
		tx.Rollback()
		if created {
			_ = os.Remove(assetDir)
		}
		return fmt.Errorf("boardphotos: stage source file: %w", err)
	}
	if err := os.Rename(proc.RenderPath, renderNew); err != nil {
		tx.Rollback()
		os.Remove(srcNew)
		if created {
			_ = os.Remove(assetDir)
		}
		return fmt.Errorf("boardphotos: stage render file: %w", err)
	}
	meta := OverlayMeta{
		SourcePath:   filepath.Join(asset.ID, side+"."+KindSource+ext),
		SourceMIME:   proc.SourceMIME,
		SourceSize:   proc.SourceSize,
		RenderPath:   filepath.Join(asset.ID, side+"."+KindRender+ext),
		RenderWidth:  proc.RenderWidth,
		RenderHeight: proc.RenderHeight,
	}
	if err := s.store.UpsertOverlayTx(tx, asset.ID, side, meta, calibration); err != nil {
		tx.Rollback()
		removeStaged(srcNew, renderNew)
		if created {
			_ = os.Remove(assetDir)
		}
		return err
	}

	srcBackup, err := installFile(srcNew, srcTarget)
	if err != nil {
		tx.Rollback()
		removeStaged(srcNew, renderNew)
		if created {
			_ = os.Remove(assetDir)
		}
		return err
	}
	renderBackup, err := installFile(renderNew, renderTarget)
	if err != nil {
		tx.Rollback()
		undoInstall(srcTarget, srcBackup)
		removeStaged(renderNew)
		if created {
			_ = os.Remove(assetDir)
		}
		return err
	}
	if err := tx.Commit(); err != nil {
		undoInstall(srcTarget, srcBackup)
		undoInstall(renderTarget, renderBackup)
		return fmt.Errorf("boardphotos: commit overlay: %w", err)
	}

	// Committed: the backups only hold the replaced old files now.
	if srcBackup != "" {
		os.Remove(srcBackup)
	}
	if renderBackup != "" {
		os.Remove(renderBackup)
	}
	// A format change uses a new canonical extension. Remove the obsolete
	// extension only after the database commit, so a failed replacement keeps
	// every previous file intact.
	oldExt := ".jpg"
	if ext == oldExt {
		oldExt = ".png"
	}
	os.Remove(filepath.Join(assetDir, side+"."+KindSource+oldExt))
	os.Remove(filepath.Join(assetDir, side+"."+KindRender+oldExt))
	return nil
}

// UpdateCalibration stores or clears (empty string) the calibration JSON
// for one side. Image files are never touched. ErrNotFound when the side
// has no overlay yet.
func (s *Service) UpdateCalibration(boardKey, side, calibration string) error {
	if err := ValidateBoardKey(boardKey); err != nil {
		return err
	}
	return s.store.UpdateCalibration(boardKey, side, calibration)
}

// DeleteOverlay removes the overlay row for one side and its image files.
// Files are moved to backups first; only after the metadata deletion has
// committed are the backups removed. On any failure the backups are
// restored, so the row and files stay unchanged. A file already missing on
// disk is tolerated; every other filesystem error aborts the deletion.
func (s *Service) DeleteOverlay(boardKey, side string) error {
	if err := ValidateBoardKey(boardKey); err != nil {
		return err
	}
	if err := validateSide(side); err != nil {
		return err
	}
	asset, err := s.store.GetAsset(boardKey)
	if err != nil {
		return err
	}
	tx, err := s.store.db.Writer().Begin()
	if err != nil {
		return fmt.Errorf("boardphotos: begin tx: %w", err)
	}
	defer tx.Rollback()
	ov, err := s.store.GetOverlayTx(tx, asset.ID, side)
	if err != nil {
		tx.Rollback()
		return err
	}

	srcAbs, err := s.resolveStored(asset.ID, side, KindSource, ov.SourcePath)
	if err != nil {
		tx.Rollback()
		return err
	}
	renderAbs := ""
	if ov.RenderPath != "" {
		renderAbs, err = s.resolveStored(asset.ID, side, KindRender, ov.RenderPath)
		if err != nil {
			tx.Rollback()
			return err
		}
	}

	srcBackup, err := backupFile(srcAbs)
	if err != nil {
		tx.Rollback()
		return err
	}
	renderBackup := ""
	if renderAbs != "" {
		renderBackup, err = backupFile(renderAbs)
		if err != nil {
			restoreFile(srcAbs, srcBackup)
			tx.Rollback()
			return err
		}
	}

	if err := s.store.DeleteSideTx(tx, asset.ID, side); err != nil {
		restoreFile(srcAbs, srcBackup)
		restoreFile(renderAbs, renderBackup)
		tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		restoreFile(srcAbs, srcBackup)
		restoreFile(renderAbs, renderBackup)
		return fmt.Errorf("boardphotos: commit delete: %w", err)
	}

	if srcBackup != "" {
		os.Remove(srcBackup)
	}
	if renderBackup != "" {
		os.Remove(renderBackup)
	}
	return nil
}

// ResolveImage returns the absolute path of the source or render image for
// one side. The stored path is checked against the canonical layout, so a
// tampered metadata row can never resolve outside the overlays root. The
// result is meant for opening the file, not for serving it publicly.
func (s *Service) ResolveImage(boardKey, side, kind string) (string, error) {
	if err := ValidateBoardKey(boardKey); err != nil {
		return "", err
	}
	if err := validateSide(side); err != nil {
		return "", err
	}
	if err := validateKind(kind); err != nil {
		return "", err
	}
	ov, err := s.store.GetOverlay(boardKey, side)
	if err != nil {
		return "", err
	}
	stored := ov.SourcePath
	if kind == KindRender {
		stored = ov.RenderPath
	}
	return s.resolveStored(ov.AssetID, side, kind, stored)
}

// OpenImage opens the source or render image of one side for reading.
func (s *Service) OpenImage(boardKey, side, kind string) (*os.File, error) {
	path, err := s.ResolveImage(boardKey, side, kind)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("boardphotos: open %s image: %w", kind, err)
	}
	return f, nil
}

// resolveStored validates that stored is exactly the canonical relative
// path "<assetID>/<side>.<kind>.<jpg|png>" for the given asset and side,
// then returns the absolute path under the overlays root.
func (s *Service) resolveStored(assetID, side, kind, stored string) (string, error) {
	if stored == "" {
		return "", fmt.Errorf("boardphotos: no %s file stored for %s side", kind, side)
	}
	if assetID == "" || strings.ContainsAny(assetID, "/\\") || assetID == "." || assetID == ".." {
		return "", errors.New("boardphotos: invalid asset id")
	}
	clean := filepath.Clean(stored)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("boardphotos: overlay path %q escapes the overlays root", stored)
	}
	ext := filepath.Ext(clean)
	if ext != ".jpg" && ext != ".png" {
		return "", fmt.Errorf("boardphotos: unexpected overlay file extension %q", ext)
	}
	if clean != filepath.Join(assetID, side+"."+kind+ext) {
		return "", fmt.Errorf("boardphotos: overlay path %q does not belong to asset %s", stored, assetID)
	}
	return filepath.Join(s.root, clean), nil
}

// extFor maps the cleaned output MIME type to its file extension.
func extFor(mime string) (string, error) {
	switch mime {
	case "image/jpeg":
		return ".jpg", nil
	case "image/png":
		return ".png", nil
	}
	return "", fmt.Errorf("boardphotos: unexpected image MIME %q", mime)
}

// validateKind accepts only the two known file kinds.
func validateKind(kind string) error {
	if kind != KindSource && kind != KindRender {
		return fmt.Errorf("boardphotos: kind must be %q or %q, got %q", KindSource, KindRender, kind)
	}
	return nil
}

// backupFile renames target to target+".bak" and returns the backup path.
// A target that does not exist is not an error; the empty string signals
// that there was no old file.
func backupFile(target string) (string, error) {
	if _, err := os.Stat(target); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", fmt.Errorf("boardphotos: stat %s: %w", filepath.Base(target), err)
	}
	backup := target + ".bak"
	if err := os.Rename(target, backup); err != nil {
		return "", fmt.Errorf("boardphotos: back up %s: %w", filepath.Base(target), err)
	}
	return backup, nil
}

// installFile atomically moves newPath onto target, backing up an existing
// target first. It returns the backup path so the caller can undo.
func installFile(newPath, target string) (string, error) {
	backup, err := backupFile(target)
	if err != nil {
		return "", err
	}
	if err := os.Rename(newPath, target); err != nil {
		restoreFile(target, backup)
		return "", fmt.Errorf("boardphotos: install %s: %w", filepath.Base(target), err)
	}
	return backup, nil
}

// undoInstall reverses installFile: the backup moves back, or a newly
// installed file is removed when there was no old one.
func undoInstall(target, backup string) {
	if backup != "" {
		os.Rename(backup, target)
		return
	}
	os.Remove(target)
}

// restoreFile moves a backup back to its original name; it is a no-op when
// there was no backup because the file did not exist before.
func restoreFile(target, backup string) {
	if backup == "" {
		return
	}
	os.Rename(backup, target)
}

// removeStaged deletes freshly staged temporary files, ignoring errors.
func removeStaged(paths ...string) {
	for _, p := range paths {
		os.Remove(p)
	}
}
