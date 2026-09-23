package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
)

// Wire types for the validated JSON payloads. Field names match the
// frontend types in src/frontend/src/photo-overlay/types.ts.

type boardPhotoPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// UnmarshalJSON keeps the public validator fields convenient to inspect while
// still distinguishing a missing coordinate from the valid value 0.
func (p *boardPhotoPoint) UnmarshalJSON(data []byte) error {
	var raw struct {
		X *float64 `json:"x"`
		Y *float64 `json:"y"`
	}
	dec := json.NewDecoder(bytesReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&raw); err != nil {
		return err
	}
	if raw.X == nil || raw.Y == nil {
		return fmt.Errorf("point requires both x and y")
	}
	p.X, p.Y = *raw.X, *raw.Y
	return nil
}

type boardPhotoMask struct {
	Points []boardPhotoPoint `json:"points"`
}

type boardPhotoCalibrationPointPair struct {
	ID    *int            `json:"id"`
	Board boardPhotoPoint `json:"board"`
	Photo boardPhotoPoint `json:"photo"`
}

type boardPhotoCalibration struct {
	Version int                              `json:"version"`
	Points  []boardPhotoCalibrationPointPair `json:"points"`
}

// validateBoardPhotoMask checks that the mask payload is valid JSON and has
// the required structure: at least three points, all coordinates finite and
// normalized to 0..1. Math degeneracy is assessed by the frontend.
func validateBoardPhotoMask(body []byte) error {
	if !json.Valid(body) {
		return fmt.Errorf("%w: mask is not valid JSON", errInvalidBoardPhotoJSON)
	}
	var mask boardPhotoMask
	dec := json.NewDecoder(bytesReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&mask); err != nil {
		return fmt.Errorf("%w: mask has unexpected shape: %v", errInvalidBoardPhotoJSON, err)
	}
	if len(mask.Points) < 3 {
		return fmt.Errorf("%w: mask needs at least 3 points", errInvalidBoardPhotoJSON)
	}
	for i, p := range mask.Points {
		if !validBoardPhotoCoord(p.X) || !validBoardPhotoCoord(p.Y) {
			return fmt.Errorf("%w: mask point %d is not a finite coordinate in 0..1", errInvalidBoardPhotoJSON, i)
		}
	}
	return nil
}

// minCalibrationPairs / maxCalibrationPairs match the frontend
// solveHomography bounds (4..12 pairs).
const (
	minCalibrationPairs = 4
	maxCalibrationPairs = 12
)

// validateBoardPhotoCalibration checks that the calibration payload is the
// frozen contract version-1 shape: {version, points} with 4 to 12 complete
// pairs whose IDs are present, positive, integer, and unique, and whose
// coordinates are finite and normalized to 0..1. No side and no homography:
// those are not part of the wire format. Math degeneracy is assessed by the
// frontend.
func validateBoardPhotoCalibration(body []byte) error {
	if !json.Valid(body) {
		return fmt.Errorf("%w: calibration is not valid JSON", errInvalidBoardPhotoJSON)
	}
	var cal boardPhotoCalibration
	dec := json.NewDecoder(bytesReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cal); err != nil {
		return fmt.Errorf("%w: calibration has unexpected shape: %v", errInvalidBoardPhotoJSON, err)
	}
	if cal.Version != 1 {
		return fmt.Errorf("%w: calibration version must be 1, got %d", errInvalidBoardPhotoJSON, cal.Version)
	}
	if len(cal.Points) < minCalibrationPairs || len(cal.Points) > maxCalibrationPairs {
		return fmt.Errorf("%w: calibration needs 4 to 12 point pairs, got %d", errInvalidBoardPhotoJSON, len(cal.Points))
	}
	seenIDs := make(map[int]struct{}, len(cal.Points))
	for i, pair := range cal.Points {
		if pair.ID == nil {
			return fmt.Errorf("%w: calibration pair %d is missing a numeric id", errInvalidBoardPhotoJSON, i)
		}
		if *pair.ID <= 0 {
			return fmt.Errorf("%w: calibration pair %d has a non-positive id", errInvalidBoardPhotoJSON, i)
		}
		if _, exists := seenIDs[*pair.ID]; exists {
			return fmt.Errorf("%w: calibration pair %d has a duplicate id", errInvalidBoardPhotoJSON, i)
		}
		seenIDs[*pair.ID] = struct{}{}
		for _, p := range []boardPhotoPoint{pair.Board, pair.Photo} {
			if !validBoardPhotoCoord(p.X) || !validBoardPhotoCoord(p.Y) {
				return fmt.Errorf("%w: calibration pair %d has a non-finite coordinate outside 0..1", errInvalidBoardPhotoJSON, i)
			}
		}
	}
	return nil
}

// validBoardPhotoCoord reports whether v is a finite number in 0..1.
func validBoardPhotoCoord(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v <= 1
}

// bytesReader wraps a byte slice for the JSON decoders.
func bytesReader(b []byte) *bytes.Reader {
	return bytes.NewReader(b)
}
