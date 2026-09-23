import { describe, expect, it } from 'vitest';
import { validateManualBoardMask } from './mask-validation';
import type { ManualBoardMask, NormalizedPoint } from './types';

function mask(points: NormalizedPoint[]): ManualBoardMask {
  return { points };
}

describe('validateManualBoardMask', () => {
  it('akzeptiert implizit geschlossene konvexe und konkave Außenkonturen', () => {
    expect(validateManualBoardMask(mask([
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.5, y: 0.9 },
    ]))).toEqual({ valid: true, reason: null });

    expect(validateManualBoardMask(mask([
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.5, y: 0.5 },
      { x: 0.1, y: 0.9 },
    ])).valid).toBe(true);
  });

  it('verlangt mindestens drei endliche Punkte', () => {
    expect(validateManualBoardMask(mask([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ])).valid).toBe(false);
    expect(validateManualBoardMask(mask([
      { x: 0, y: 0 },
      { x: Number.NaN, y: 0 },
      { x: 0, y: 1 },
    ])).valid).toBe(false);
  });

  it('lehnt Selbstüberschneidungen ab', () => {
    const bowTie = mask([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ]);

    expect(validateManualBoardMask(bowTie)).toMatchObject({
      valid: false,
      reason: expect.stringContaining('selbst'),
    });
  });

  it('lehnt Selbstberührung und kollineare Überlappung ab', () => {
    const touching = mask([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 0.5, y: 0.5 },
    ]);
    expect(validateManualBoardMask(touching).valid).toBe(false);

    const overlapping = mask([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.25, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    expect(validateManualBoardMask(overlapping).valid).toBe(false);
  });

  it('lehnt Kanten ohne Länge und explizit wiederholte Schließpunkte ab', () => {
    expect(validateManualBoardMask(mask([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ])).valid).toBe(false);
    expect(validateManualBoardMask(mask([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 0 },
    ])).valid).toBe(false);
  });

  it('lehnt degenerierte Fläche ab', () => {
    expect(validateManualBoardMask(mask([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ])).valid).toBe(false);
  });
});
