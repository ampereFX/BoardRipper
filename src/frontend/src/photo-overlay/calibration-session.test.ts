import { describe, expect, it } from 'vitest';
import {
  CalibrationSession,
  CalibrationSessionError,
  RECOMMENDED_CALIBRATION_PAIRS,
} from './calibration-session';
import { applyHomography } from './homography';
import type { CalibrationPointPair, NormalizedPoint } from './types';

const BOARD_POINTS: NormalizedPoint[] = [
  { x: 0.05, y: 0.08 },
  { x: 0.94, y: 0.06 },
  { x: 0.91, y: 0.93 },
  { x: 0.07, y: 0.89 },
  { x: 0.48, y: 0.45 },
  { x: 0.23, y: 0.29 },
  { x: 0.72, y: 0.24 },
];

const MATRIX = [
  0.82, 0.03, 0.08,
  -0.02, 0.79, 0.11,
  0.02, -0.01, 1,
];

function photoPoint(board: NormalizedPoint): NormalizedPoint {
  return applyHomography(MATRIX, board);
}

function addPairs(session: CalibrationSession, count: number): CalibrationPointPair[] {
  return BOARD_POINTS.slice(0, count).map((board) => session.addPair(board, photoPoint(board)));
}

describe('CalibrationSession', () => {
  it('führt Board- und Fotopunkt in nummerierten Paaren zusammen und verwaltet Auswahl, Move und Delete', () => {
    const session = new CalibrationSession();
    const board = session.addBoardPoint(BOARD_POINTS[0]);
    expect(board).toEqual(BOARD_POINTS[0]);
    const first = session.addPhotoPoint(photoPoint(board));
    const second = session.addPair(BOARD_POINTS[1], photoPoint(BOARD_POINTS[1]));

    expect([first.id, second.id]).toEqual([1, 2]);
    expect(session.getNumberedPairs().map((entry) => entry.number)).toEqual([1, 2]);
    expect(session.getState().activePairId).toBe(second.id);
    session.selectPair(first.id);
    session.movePhotoPoint(first.id, { x: 0.2, y: 0.2 });
    expect(session.getActivePair()?.photo).toEqual({ x: 0.2, y: 0.2 });
    session.deletePair(first.id);
    expect(session.getState().activePairId).toBe(second.id);
  });

  it('hält Preview sowie Reference- und Photo-Viewport unabhängig', () => {
    const session = new CalibrationSession();
    session.setPreview('compare');
    session.setZoom('reference', 2);
    session.setPan('reference', { x: -0.2, y: 0.1 });
    session.setZoom('photo', 3);

    expect(session.getState()).toMatchObject({
      preview: 'compare',
      referenceViewport: { zoom: 2, pan: { x: -0.2, y: 0.1 } },
      photoViewport: { zoom: 3, pan: { x: 0, y: 0 } },
    });
  });

  it('snappt Boardpunkte an die Outline und verwaltet eine manuelle Maske', () => {
    const session = new CalibrationSession({
      boardOutline: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
    });
    session.setOutlineSnap(true);
    const pair = session.addPair({ x: 0.5, y: 0.105 }, { x: 0.5, y: 0.2 });
    expect(pair.board).toEqual({ x: 0.5, y: 0.1 });

    session.setManualMask({ points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }] });
    expect(session.getState().validation.mask?.valid).toBe(false);
    session.addManualMaskPoint({ x: 0.9, y: 0.9 });
    expect(session.commitMask()).toEqual({
      points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }],
    });
  });

  it('zeigt bei vier Punkten keine Statistik und empfiehlt sechs Punkte', () => {
    const session = new CalibrationSession();
    addPairs(session, 4);
    expect(session.getValidation()).toMatchObject({
      valid: true,
      statistics: null,
      isRecommended: false,
    });
    session.addPair(BOARD_POINTS[4], photoPoint(BOARD_POINTS[4]));
    session.addPair(BOARD_POINTS[5], photoPoint(BOARD_POINTS[5]));
    expect(session.getState().pairs).toHaveLength(RECOMMENDED_CALIBRATION_PAIRS);
    expect(session.getValidation().isRecommended).toBe(true);
  });

  it('verlangt ab fünf Punkten eine Bestätigung für einen Reprojektionsfehler über 0,0075', () => {
    const session = new CalibrationSession();
    const pairs = addPairs(session, 5);
    session.movePhotoPoint(pairs[4].id, { x: pairs[4].photo.x + 0.08, y: pairs[4].photo.y });

    const validation = session.getValidation();
    expect(validation.statistics).not.toBeNull();
    expect(validation.warnings).toContain('Der Reprojektionsfehler liegt über der Warnschwelle von 0,75 %.');
    expect(validation.canCommit).toBe(false);
    expect(() => session.commit()).toThrow(CalibrationSessionError);
    session.confirmWarning();
    expect(session.commit().points).toHaveLength(5);
  });

  it('reicht physische Boarddimensionen an die Reprojektionsfehler-Metrik weiter', () => {
    const wide = new CalibrationSession({ boardDimensions: { width: 4, height: 1 } });
    const tall = new CalibrationSession({ boardDimensions: { width: 1, height: 4 } });
    const widePairs = addPairs(wide, 5);
    const tallPairs = addPairs(tall, 5);
    wide.movePhotoPoint(widePairs[4].id, {
      x: widePairs[4].photo.x + 0.04,
      y: widePairs[4].photo.y,
    });
    tall.movePhotoPoint(tallPairs[4].id, {
      x: tallPairs[4].photo.x + 0.04,
      y: tallPairs[4].photo.y,
    });

    expect(wide.getValidation().statistics!.maxError)
      .toBeGreaterThan(tall.getValidation().statistics!.maxError * 2);
  });

  it('verwirft ungültige Boarddimensionen und nutzt standardmäßig das Einheitsquadrat', () => {
    expect(() => new CalibrationSession({ boardDimensions: { width: 0, height: 1 } }))
      .toThrow(CalibrationSessionError);
    expect(() => new CalibrationSession({ boardDimensions: { width: 1, height: Number.NaN } }))
      .toThrow(CalibrationSessionError);

    const session = new CalibrationSession();
    addPairs(session, 4);
    expect(session.getValidation().statistics).toBeNull();
    expect(session.getValidation().warnings).toEqual([]);
  });

  it('blockiert degenerierte Kalibrierungen auch ohne Bestätigung', () => {
    const session = new CalibrationSession();
    const line = [0.1, 0.3, 0.5, 0.7].map((x) => ({ x, y: x }));
    line.forEach((board) => session.addPair(board, board));

    expect(session.getValidation()).toMatchObject({ valid: false, canCommit: false });
    expect(() => session.confirmWarning()).toThrow(CalibrationSessionError);
    expect(() => session.commit()).toThrow(CalibrationSessionError);
  });

  it('verwirft beim Cancel nur den Draft und verändert die Eingabedaten nicht', () => {
    const initial = {
      version: 1 as const,
      points: [{ id: 1, board: BOARD_POINTS[0], photo: photoPoint(BOARD_POINTS[0]) },
        { id: 2, board: BOARD_POINTS[1], photo: photoPoint(BOARD_POINTS[1]) },
        { id: 3, board: BOARD_POINTS[2], photo: photoPoint(BOARD_POINTS[2]) },
        { id: 4, board: BOARD_POINTS[3], photo: photoPoint(BOARD_POINTS[3]) }],
    };
    const original = JSON.parse(JSON.stringify(initial)) as typeof initial;
    const session = new CalibrationSession({ initialCalibration: initial });
    session.moveBoardPoint(1, { x: 0.2, y: 0.2 });
    session.addPair(BOARD_POINTS[4], photoPoint(BOARD_POINTS[4]));
    session.cancel();

    expect(initial).toEqual(original);
    expect(session.getState()).toMatchObject({ cancelled: true, pairs: original.points });
  });
});
