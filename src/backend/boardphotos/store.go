// Package boardphotos persists PCB photo-overlay metadata in the databank
// SQLite file (databank.db). It stores only paths and metadata: image files
// themselves are written elsewhere by the caller. The schema lives in
// databank.migrateV12 (tables board_photo_assets / board_photo_overlays).
package boardphotos

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"boardripper/databank"
)

// Overlay side values, matching the frontend OverlaySide type.
const (
	SideTop    = "top"
	SideBottom = "bottom"
)

// ErrNotFound is returned when no row matches the lookup key.
var ErrNotFound = errors.New("boardphotos: not found")

// ErrInvalidBoardKey marks a board key that is not in the frontend's
// <geometry-fingerprint>#<occurrence-index> format.
var ErrInvalidBoardKey = errors.New("boardphotos: invalid board key")

// Store reads and writes photo-overlay metadata through the shared databank
// connection pools. It borrows the single-connection write pool so all
// writers to databank.db stay serialised.
type Store struct {
	db *databank.DB
}

// NewStore returns a store backed by the given databank handle. The schema
// must already exist: databank.Open runs migrateV12, which creates it.
func NewStore(db *databank.DB) *Store {
	return &Store{db: db}
}

// Asset is one unique sub-board geometry (one row of board_photo_assets).
type Asset struct {
	ID                  string
	BoardKey            string
	GeometryFingerprint string
	OccurrenceIndex     int
	ManualMask          string // JSON or empty
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

// Overlay is one photographed side of an asset (top or bottom).
type Overlay struct {
	AssetID      string
	Side         string
	SourcePath   string
	SourceMIME   string
	SourceSize   int64
	RenderPath   string
	RenderWidth  int
	RenderHeight int
	Calibration  string // JSON or empty
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// OverlayMeta carries the metadata written by UpsertOverlay. Empty strings
// and zero numbers clear the corresponding columns; callers pass what they
// have. Calibration is handled separately by UpdateCalibration.
type OverlayMeta struct {
	SourcePath   string
	SourceMIME   string
	SourceSize   int64
	RenderPath   string
	RenderWidth  int
	RenderHeight int
}

// parseBoardKey splits "<fingerprint>#<index>" into its parts.
func parseBoardKey(boardKey string) (fingerprint string, index int, err error) {
	fp, idx, ok := strings.Cut(boardKey, "#")
	if !ok || fp == "" || idx == "" {
		return "", 0, fmt.Errorf("%w: board_key must be <fingerprint>#<index>, got %q", ErrInvalidBoardKey, boardKey)
	}
	n, err := strconv.Atoi(idx)
	if err != nil || n < 0 {
		return "", 0, fmt.Errorf("%w: board_key occurrence index must be a non-negative integer, got %q", ErrInvalidBoardKey, idx)
	}
	return fp, n, nil
}

// ValidateBoardKey validates a key before a mutating operation does work.
// Reads intentionally remain opaque lookups so an unknown key can return the
// frontend's empty state.
func ValidateBoardKey(boardKey string) error {
	_, _, err := parseBoardKey(boardKey)
	return err
}

// validateSide rejects anything but the two known sides.
func validateSide(side string) error {
	if side != SideTop && side != SideBottom {
		return fmt.Errorf("boardphotos: side must be %q or %q, got %q", SideTop, SideBottom, side)
	}
	return nil
}

// validateJSON reports whether s is empty or parses as a JSON value.
func validateJSON(field, s string) error {
	if s == "" {
		return nil
	}
	if !json.Valid([]byte(s)) {
		return fmt.Errorf("boardphotos: %s is not valid JSON", field)
	}
	return nil
}

// nowUnix returns the current UTC time in seconds, matching timestamp
// granularity used elsewhere in the databank.
func nowUnix() int64 { return time.Now().UTC().Unix() }

// nullStr maps empty strings to SQL NULL.
func nullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

// newUUID returns a random RFC 4122 version-4 UUID string.
func newUUID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("boardphotos: generate uuid: %w", err)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	// Format as the canonical 8-4-4-4-12 hex layout.
	sb := strings.Builder{}
	sb.Grow(36)
	for i := range buf {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			sb.WriteByte('-')
		}
		sb.WriteString(hex.EncodeToString(buf[i : i+1]))
	}
	return sb.String(), nil
}

// GetOrCreateAsset returns the asset for a board key, creating it when
// missing. manualMask (optional JSON) is only written on create; later calls
// with a different mask do not overwrite — SetManualMask is explicit.
func (s *Store) GetOrCreateAsset(boardKey, manualMask string) (*Asset, error) {
	tx, err := s.db.Writer().Begin()
	if err != nil {
		return nil, fmt.Errorf("boardphotos: begin asset: %w", err)
	}
	defer tx.Rollback()
	asset, _, err := s.getOrCreateAssetTx(tx, boardKey, manualMask)
	if err != nil {
		tx.Rollback()
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("boardphotos: commit asset: %w", err)
	}
	return asset, nil
}

// getOrCreateAssetTx atomically inserts an asset when it is absent and reads
// the resulting row through the same transaction. The created result lets a
// service caller remove filesystem scaffolding again when its transaction is
// rolled back.
func (s *Store) getOrCreateAssetTx(tx *sql.Tx, boardKey, manualMask string) (*Asset, bool, error) {
	fp, index, err := parseBoardKey(boardKey)
	if err != nil {
		return nil, false, err
	}
	if err := validateJSON("manual_mask", manualMask); err != nil {
		return nil, false, err
	}

	id, err := newUUID()
	if err != nil {
		return nil, false, err
	}
	now := nowUnix()
	result, err := tx.Exec(
		`INSERT INTO board_photo_assets (id, board_key, geometry_fingerprint, occurrence_index, manual_mask, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(board_key) DO NOTHING`,
		id, boardKey, fp, index, nullStr(manualMask), now, now,
	)
	if err != nil {
		return nil, false, fmt.Errorf("boardphotos: insert asset: %w", err)
	}
	created, err := result.RowsAffected()
	if err != nil {
		return nil, false, fmt.Errorf("boardphotos: inspect asset insert: %w", err)
	}

	row := tx.QueryRow(
		`SELECT id, board_key, geometry_fingerprint, occurrence_index, manual_mask, created_at, updated_at
		 FROM board_photo_assets WHERE board_key = ?`, boardKey)
	asset, err := scanAsset(row)
	if err != nil {
		return nil, false, err
	}
	return asset, created != 0, nil
}

// GetAsset returns the asset for a board key, or ErrNotFound.
func (s *Store) GetAsset(boardKey string) (*Asset, error) {
	if boardKey == "" {
		return nil, ErrNotFound
	}
	return s.assetByKey(boardKey)
}

// assetByKey reads the asset row for a board key from the reader pool.
func (s *Store) assetByKey(boardKey string) (*Asset, error) {
	row := s.db.Conn().QueryRow(
		`SELECT id, board_key, geometry_fingerprint, occurrence_index, manual_mask, created_at, updated_at
		 FROM board_photo_assets WHERE board_key = ?`, boardKey)
	return scanAsset(row)
}

func scanAsset(row *sql.Row) (*Asset, error) {
	var a Asset
	var mask sql.NullString
	var createdAt, updatedAt int64
	if err := row.Scan(&a.ID, &a.BoardKey, &a.GeometryFingerprint, &a.OccurrenceIndex, &mask, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("boardphotos: scan asset: %w", err)
	}
	a.ManualMask = mask.String
	a.CreatedAt = time.Unix(createdAt, 0).UTC()
	a.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	return &a, nil
}

// SetManualMask stores or clears (empty string) the manual mask JSON and
// touches updated_at. ErrNotFound when the board key has no asset row.
func (s *Store) SetManualMask(boardKey, mask string) error {
	if err := validateJSON("manual_mask", mask); err != nil {
		return err
	}
	res, err := s.db.Writer().Exec(
		`UPDATE board_photo_assets SET manual_mask = ?, updated_at = ? WHERE board_key = ?`,
		nullStr(mask), nowUnix(), boardKey,
	)
	if err != nil {
		return fmt.Errorf("boardphotos: set manual mask: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetOverlay returns the overlay row for one side of an asset, or ErrNotFound.
func (s *Store) GetOverlay(boardKey, side string) (*Overlay, error) {
	if err := validateSide(side); err != nil {
		return nil, err
	}
	asset, err := s.GetAsset(boardKey)
	if err != nil {
		return nil, err
	}
	row := s.db.Conn().QueryRow(
		`SELECT asset_id, side, source_path, source_mime, source_size, render_path, render_width, render_height, calibration, created_at, updated_at
		 FROM board_photo_overlays WHERE asset_id = ? AND side = ?`,
		asset.ID, side)
	return scanOverlay(row)
}

func scanOverlay(row *sql.Row) (*Overlay, error) {
	var o Overlay
	var calibration sql.NullString
	var createdAt, updatedAt int64
	if err := row.Scan(&o.AssetID, &o.Side, &o.SourcePath, &o.SourceMIME, &o.SourceSize,
		&o.RenderPath, &o.RenderWidth, &o.RenderHeight, &calibration, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("boardphotos: scan overlay: %w", err)
	}
	o.Calibration = calibration.String
	o.CreatedAt = time.Unix(createdAt, 0).UTC()
	o.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	return &o, nil
}

// UpsertOverlay atomically writes the full metadata row for one side. The
// asset must exist. A non-empty calibration is written; an empty one leaves
// any existing value alone — use UpdateCalibration to clear it.
func (s *Store) UpsertOverlay(boardKey, side string, meta OverlayMeta, calibration string) error {
	if err := validateSide(side); err != nil {
		return err
	}
	if err := validateJSON("calibration", calibration); err != nil {
		return err
	}
	asset, err := s.GetAsset(boardKey)
	if err != nil {
		return err
	}
	now := nowUnix()
	tx, err := s.db.Writer().Begin()
	if err != nil {
		return fmt.Errorf("boardphotos: begin tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`INSERT INTO board_photo_overlays (asset_id, side, source_path, source_mime, source_size, render_path, render_width, render_height, calibration, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(asset_id, side) DO UPDATE SET
		   source_path = excluded.source_path, source_mime = excluded.source_mime,
		   source_size = excluded.source_size, render_path = excluded.render_path,
		   render_width = excluded.render_width, render_height = excluded.render_height,
		   calibration = COALESCE(?, calibration), updated_at = excluded.updated_at`,
		asset.ID, side, meta.SourcePath, meta.SourceMIME, meta.SourceSize,
		meta.RenderPath, meta.RenderWidth, meta.RenderHeight, nullStr(calibration), now, now,
		nullStr(calibration),
	); err != nil {
		return fmt.Errorf("boardphotos: upsert overlay: %w", err)
	}
	return tx.Commit()
}

// UpdateCalibration writes or clears (empty string) only the calibration JSON
// and touches updated_at. ErrNotFound when the asset or side row is missing.
func (s *Store) UpdateCalibration(boardKey, side, calibration string) error {
	if err := validateSide(side); err != nil {
		return err
	}
	if err := validateJSON("calibration", calibration); err != nil {
		return err
	}
	asset, err := s.GetAsset(boardKey)
	if err != nil {
		return err
	}
	res, err := s.db.Writer().Exec(
		`UPDATE board_photo_overlays SET calibration = ?, updated_at = ? WHERE asset_id = ? AND side = ?`,
		nullStr(calibration), nowUnix(), asset.ID, side,
	)
	if err != nil {
		return fmt.Errorf("boardphotos: update calibration: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteSide removes the overlay row for one side. ErrNotFound when there is
// no row for that side.
func (s *Store) DeleteSide(boardKey, side string) error {
	if err := validateSide(side); err != nil {
		return err
	}
	asset, err := s.GetAsset(boardKey)
	if err != nil {
		return err
	}
	res, err := s.db.Writer().Exec(
		`DELETE FROM board_photo_overlays WHERE asset_id = ? AND side = ?`, asset.ID, side)
	if err != nil {
		return fmt.Errorf("boardphotos: delete side: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetOverlayTx reads the overlay row for one side inside a caller-provided
// writer transaction, so the service can share one transaction boundary
// with its file operations. ErrNotFound when there is no row.
func (s *Store) GetOverlayTx(tx *sql.Tx, assetID, side string) (*Overlay, error) {
	if err := validateSide(side); err != nil {
		return nil, err
	}
	row := tx.QueryRow(
		`SELECT asset_id, side, source_path, source_mime, source_size, render_path, render_width, render_height, calibration, created_at, updated_at
		 FROM board_photo_overlays WHERE asset_id = ? AND side = ?`,
		assetID, side)
	return scanOverlay(row)
}

// UpsertOverlayTx writes the full metadata row for one side inside a
// caller-provided writer transaction. The asset row must already exist.
// A non-empty calibration is written; an empty one leaves an existing
// value alone.
func (s *Store) UpsertOverlayTx(tx *sql.Tx, assetID, side string, meta OverlayMeta, calibration string) error {
	if err := validateSide(side); err != nil {
		return err
	}
	if err := validateJSON("calibration", calibration); err != nil {
		return err
	}
	now := nowUnix()
	if _, err := tx.Exec(
		`INSERT INTO board_photo_overlays (asset_id, side, source_path, source_mime, source_size, render_path, render_width, render_height, calibration, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(asset_id, side) DO UPDATE SET
		   source_path = excluded.source_path, source_mime = excluded.source_mime,
		   source_size = excluded.source_size, render_path = excluded.render_path,
		   render_width = excluded.render_width, render_height = excluded.render_height,
		   calibration = COALESCE(?, calibration), updated_at = excluded.updated_at`,
		assetID, side, meta.SourcePath, meta.SourceMIME, meta.SourceSize,
		meta.RenderPath, meta.RenderWidth, meta.RenderHeight, nullStr(calibration), now, now,
		nullStr(calibration),
	); err != nil {
		return fmt.Errorf("boardphotos: upsert overlay: %w", err)
	}
	return nil
}

// DeleteSideTx removes the overlay row for one side inside a
// caller-provided writer transaction. ErrNotFound when there is no row.
func (s *Store) DeleteSideTx(tx *sql.Tx, assetID, side string) error {
	if err := validateSide(side); err != nil {
		return err
	}
	res, err := tx.Exec(
		`DELETE FROM board_photo_overlays WHERE asset_id = ? AND side = ?`, assetID, side)
	if err != nil {
		return fmt.Errorf("boardphotos: delete side: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
