import { describe, expect, it } from 'vitest';
import type { Point } from '../parsers/types';
import type { ManualBoardMask, NormalizedPoint } from '../photo-overlay/types';
import { boardMaskToRawCoordinates, resolveBoardMaskPolygon } from './photo-overlay-mask';

const NAN = Number.NaN;

function manualMask(polygon: NormalizedPoint[]): ManualBoardMask {
  return { points: polygon };
}

describe('resolveBoardMaskPolygon', () => {
  it('nimmt eine explizit geschlossene Outline-Kontur als Polygon', () => {
    const square: Point[] = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 },
    ];
    const result = resolveBoardMaskPolygon(square, null);

    expect(result).not.toBeNull();
    expect(result!.source).toBe('outline');
    expect(result!.polygon).toHaveLength(4);
    expect(result!.polygon).toEqual([
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ]);
  });

  it('wählt bei NaN-getrennten Konturen die äußere (größte) Kontur', () => {
    const outline: Point[] = [
      // Äußere Kontur, groß.
      { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 500 }, { x: 0, y: 500 }, { x: 0, y: 0 },
      { x: NAN, y: NAN },
      // Innere Kontur (lochähnlich, wird in V1 ignoriert).
      { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 },
      { x: 100, y: 100 },
    ];
    const result = resolveBoardMaskPolygon(outline, null);

    expect(result!.source).toBe('outline');
    expect(result!.polygon).toHaveLength(4);
    expect(result!.polygon[2]).toEqual({ x: 1000, y: 500 });
  });

  it('fällt bei nur offenen Konturen auf die manuelle Maske zurück', () => {
    const outline: Point[] = [
      { x: 0, y: 0 }, { x: 100, y: 0 },
      { x: NAN, y: NAN },
      { x: 100, y: 100 }, { x: 0, y: 100 },
    ];
    const manual = manualMask([
      { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 },
    ]);
    const result = resolveBoardMaskPolygon(outline, manual);

    expect(result!.source).toBe('manual');
    expect(result!.polygon).toEqual(manual.points);
  });

  it('fällt auch bei leerer Outline auf die manuelle Maske zurück', () => {
    const manual = manualMask([
      { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 },
    ]);
    expect(resolveBoardMaskPolygon([], manual)).toEqual({
      polygon: manual.points,
      source: 'manual',
    });
  });

  it('liefert null, wenn weder Kontur noch manuelle Maske nutzbar sind', () => {
    expect(resolveBoardMaskPolygon([], null)).toBeNull();
    const collinear: Point[] = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }];
    expect(resolveBoardMaskPolygon(collinear, null)).toBeNull();
  });

  it('bricht mit verständlicher Ursache ab, wenn die manuelle Maske ungültig ist', () => {
    const invalid = manualMask([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(() => resolveBoardMaskPolygon([], invalid)).toThrow('Die manuelle Board-Maske ist ungültig');
    expect(() => resolveBoardMaskPolygon([], invalid)).toThrow('mindestens 3 Punkte');
  });
});

describe('boardMaskToRawCoordinates', () => {
  it('projiziert manuelle Punkte direkt über die Board-Bounds', () => {
    const mask = resolveBoardMaskPolygon([], manualMask([
      { x: 0, y: 0 }, { x: 1, y: 0.25 }, { x: 0.5, y: 1 },
    ]));

    expect(boardMaskToRawCoordinates(mask, {
      minX: 100,
      maxX: 500,
      minY: -200,
      maxY: 200,
    })).toEqual([
      { x: 100, y: -200 },
      { x: 500, y: -100 },
      { x: 300, y: 200 },
    ]);
  });

  it('lässt Outline-Punkte bereits im rohen Boardraum unverändert', () => {
    const mask = resolveBoardMaskPolygon([
      { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }, { x: 10, y: 40 }, { x: 10, y: 20 },
    ], null);

    expect(boardMaskToRawCoordinates(mask, {
      minX: 1000,
      maxX: 2000,
      minY: 1000,
      maxY: 2000,
    })).toEqual([
      { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }, { x: 10, y: 40 },
    ]);
  });
});
