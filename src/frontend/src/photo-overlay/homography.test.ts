import { describe, expect, it } from 'vitest';
import { applyHomography, invertHomography, solveHomography } from './homography';
import type { CalibrationPointPair, NormalizedPoint } from './types';

const UNIT_BOARD_DIMENSIONS = { width: 1, height: 1 };

const TRUE_MATRIX = [
  1.08, 0.07, 0.03,
  -0.04, 0.96, 0.05,
  0.08, -0.06, 1,
];

const BOARD_POINTS: NormalizedPoint[] = [
  { x: 0.05, y: 0.08 },
  { x: 0.94, y: 0.06 },
  { x: 0.91, y: 0.93 },
  { x: 0.07, y: 0.89 },
  { x: 0.48, y: 0.45 },
  { x: 0.23, y: 0.29 },
  { x: 0.72, y: 0.24 },
  { x: 0.78, y: 0.69 },
  { x: 0.31, y: 0.73 },
  { x: 0.14, y: 0.53 },
  { x: 0.61, y: 0.84 },
  { x: 0.57, y: 0.13 },
];

function pairsFor(points: NormalizedPoint[], matrix = TRUE_MATRIX): CalibrationPointPair[] {
  return points.map((board, index) => ({
    id: index + 1,
    board,
    photo: applyHomography(matrix, board),
  }));
}

function expectPointClose(actual: NormalizedPoint, expected: NormalizedPoint, digits = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

describe('solveHomography', () => {
  it('rekonstruiert synthetische Homografien mit 4 bis 12 Paaren', () => {
    for (let count = 4; count <= 12; count++) {
      const pairs = pairsFor(BOARD_POINTS.slice(0, count));
      const result = solveHomography(pairs, UNIT_BOARD_DIMENSIONS);

      expect(result.error, `${count} Paare: ${result.error}`).toBeNull();
      expect(result.matrix).not.toBeNull();
      for (const pair of pairs) {
        expectPointClose(applyHomography(result.matrix!, pair.board), pair.photo, 8);
      }
      if (count === 4) {
        expect(result.rmsError).toBeNull();
        expect(result.maxError).toBeNull();
        expect(result.warnings).toEqual([]);
      } else {
        expect(result.rmsError).toBeLessThan(1e-8);
        expect(result.maxError).toBeLessThan(1e-8);
      }
    }
  });

  it('wendet eine Matrix an und invertiert sie', () => {
    const point = { x: 0.37, y: 0.62 };
    const projected = applyHomography(TRUE_MATRIX, point);
    const inverse = invertHomography(TRUE_MATRIX);

    expect(inverse).not.toBeNull();
    expectPointClose(applyHomography(inverse!, projected), point, 12);
    expect(invertHomography([1, 0, 0, 0, 0, 0, 0, 0, 1])).toBeNull();
  });

  it('blockiert zu wenige oder zu viele Paare', () => {
    expect(solveHomography(pairsFor(BOARD_POINTS.slice(0, 3)), UNIT_BOARD_DIMENSIONS).status).toBe('error');
    const thirteen = [...BOARD_POINTS, { x: 0.41, y: 0.19 }];
    expect(solveHomography(pairsFor(thirteen), UNIT_BOARD_DIMENSIONS).status).toBe('error');
  });

  it('blockiert doppelte und zu nahe Punkte', () => {
    const duplicate = pairsFor(BOARD_POINTS.slice(0, 4));
    duplicate[3] = { ...duplicate[3], board: { ...duplicate[0].board } };
    expect(solveHomography(duplicate, UNIT_BOARD_DIMENSIONS)).toMatchObject({
      status: 'error',
      matrix: null,
    });

    const tooClose = pairsFor(BOARD_POINTS.slice(0, 4));
    tooClose[3] = {
      ...tooClose[3],
      board: {
        x: tooClose[0].board.x + 1e-8,
        y: tooClose[0].board.y,
      },
    };
    expect(solveHomography(tooClose, UNIT_BOARD_DIMENSIONS).status).toBe('error');
  });

  it('blockiert kollineare und singuläre Konfigurationen', () => {
    const line = [0.05, 0.25, 0.5, 0.75, 0.95].map((x) => ({ x, y: 0.4 * x + 0.1 }));
    expect(solveHomography(pairsFor(line), UNIT_BOARD_DIMENSIONS)).toMatchObject({
      status: 'error',
      matrix: null,
    });

    const singularTarget = pairsFor(BOARD_POINTS.slice(0, 5)).map((pair, index) => ({
      ...pair,
      photo: { x: 0.1 + index * 0.15, y: 0.2 + index * 0.05 },
    }));
    expect(solveHomography(singularTarget, UNIT_BOARD_DIMENSIONS)).toMatchObject({
      status: 'error',
      matrix: null,
    });
  });

  it('markiert eine nahezu kollineare, noch lösbare Verteilung als instabil', () => {
    const narrow = [
      { x: 0.05, y: 0.498 },
      { x: 0.2, y: 0.502 },
      { x: 0.4, y: 0.497 },
      { x: 0.6, y: 0.503 },
      { x: 0.8, y: 0.499 },
      { x: 0.95, y: 0.501 },
    ];
    const result = solveHomography(pairsFor(narrow), UNIT_BOARD_DIMENSIONS);

    expect(result.status).toBe('degraded');
    expect(result.matrix).not.toBeNull();
    expect(result.warnings.some((warning) => warning.includes('Geraden') || warning.includes('instabil'))).toBe(true);
  });

  it('bewertet ab 5 Paaren den Fehler relativ zur physischen Boarddiagonale', () => {
    const pairs = pairsFor(BOARD_POINTS.slice(0, 8));
    pairs[7] = {
      ...pairs[7],
      photo: {
        x: pairs[7].photo.x + 0.08,
        y: pairs[7].photo.y - 0.05,
      },
    };
    const result = solveHomography(pairs, UNIT_BOARD_DIMENSIONS);

    expect(result.matrix).not.toBeNull();
    expect(result.rmsError).not.toBeNull();
    expect(result.maxError).not.toBeNull();
    expect(result.maxError!).toBeGreaterThan(0.0075);
    expect(result.status).toBe('degraded');
    expect(result.warnings).toContain('Der Reprojektionsfehler liegt über der Warnschwelle von 0,75 %.');
  });

  it('blockiert ungültige Skalen und Projektionssingularitäten', () => {
    expect(solveHomography(pairsFor(BOARD_POINTS.slice(0, 4)), { width: 0, height: 1 }).status).toBe('error');
    expect(() => applyHomography([1, 0, 0, 0, 1, 0, 1, 0, 0], { x: 0, y: 1 })).toThrow(RangeError);
  });

  it('gewichtet dieselbe normierte Abweichung bei breiten und hohen Boards achsenrichtig', () => {
    const pairs = pairsFor(BOARD_POINTS.slice(0, 8));
    pairs[7] = {
      ...pairs[7],
      photo: { x: pairs[7].photo.x + 0.04, y: pairs[7].photo.y },
    };

    const wide = solveHomography(pairs, { width: 4, height: 1 });
    const tall = solveHomography(pairs, { width: 1, height: 4 });

    expect(wide.error).toBeNull();
    expect(tall.error).toBeNull();
    expect(wide.maxError!).toBeGreaterThan(tall.maxError! * 2);
    expect(wide.rmsError!).toBeGreaterThan(tall.rmsError! * 2);
  });

  it('behält die 0,75-Prozent-Schwelle knapp unter und über der Schwelle', () => {
    const makePairs = (offset: number): CalibrationPointPair[] => {
      const pairs = pairsFor(BOARD_POINTS.slice(0, 8));
      pairs[7] = {
        ...pairs[7],
        photo: { x: pairs[7].photo.x + offset, y: pairs[7].photo.y },
      };
      return pairs;
    };

    const below = solveHomography(makePairs(0.014), UNIT_BOARD_DIMENSIONS);
    const above = solveHomography(makePairs(0.0145), UNIT_BOARD_DIMENSIONS);

    expect(below.warnings).not.toContain('Der Reprojektionsfehler liegt über der Warnschwelle von 0,75 %.');
    expect(above.warnings).toContain('Der Reprojektionsfehler liegt über der Warnschwelle von 0,75 %.');
  });

  it('akzeptiert positive Legacy-Normraumteiler, aber keine ungültigen Dimensionen', () => {
    expect(solveHomography(pairsFor(BOARD_POINTS.slice(0, 5)), Math.SQRT2).error).toBeNull();
    expect(solveHomography(pairsFor(BOARD_POINTS.slice(0, 5)), { width: Number.NaN, height: 1 }).status)
      .toBe('error');
    expect(solveHomography(pairsFor(BOARD_POINTS.slice(0, 5)), { width: 1, height: Number.POSITIVE_INFINITY }).status)
      .toBe('error');
  });
});
