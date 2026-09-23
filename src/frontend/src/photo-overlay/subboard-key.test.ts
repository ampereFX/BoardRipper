import { describe, expect, it } from 'vitest';
import type { BoardData, Pad, Part, Point, Via } from '../parsers/types';
import { computeSubboardKey, computeSubboardKeys } from './subboard-key';

function move(point: Point, dx: number, dy: number): Point {
  return { x: point.x + dx, y: point.y + dy };
}

function rotate<T>(values: T[], by: number): T[] {
  return [...values.slice(by), ...values.slice(0, by)];
}

function makeBoard(options: {
  dx?: number;
  dy?: number;
  reorder?: boolean;
  rename?: boolean;
  viaDiameter?: number;
} = {}): BoardData {
  const dx = options.dx ?? 0;
  const dy = options.dy ?? 0;
  const p = (x: number, y: number) => move({ x, y }, dx, dy);
  const outline = [p(0, 0), p(40, 0), p(40, 20), p(0, 20)];
  const secondContour = [p(5, 5), p(8, 5), p(8, 8), p(5, 8)];
  const orderedOutline = options.reorder
    ? [...rotate([...secondContour].reverse(), 1), { x: Number.NaN, y: Number.NaN }, ...rotate([...outline].reverse(), 2)]
    : [...outline, { x: Number.NaN, y: Number.NaN }, ...secondContour];

  const pins: Part['pins'] = [
    {
      name: options.rename ? 'anderer Pin' : 'A1',
      number: options.rename ? '99' : '1',
      position: p(10, 10),
      radius: 1.5,
      side: 'top',
      net: options.rename ? 'ANDERES_NETZ' : 'GND',
      padBounds: { minX: 8 + dx, minY: 9 + dy, maxX: 12 + dx, maxY: 11 + dy },
      padShape: 'roundrect',
      padWidth: 4,
      padHeight: 2,
      padAngleDeg: 15,
      padCornerRadius: 0.4,
      drill: 0.8,
    },
    {
      name: options.rename ? 'noch ein Pin' : 'A2',
      number: options.rename ? '100' : '2',
      position: p(30, 10),
      radius: 1,
      side: 'bottom',
      net: options.rename ? 'UNBENUTZT' : 'VCC',
    },
  ];
  const parts: Part[] = [{
    name: options.rename ? 'U999' : 'U1',
    side: 'both',
    type: 'throughhole',
    origin: p(20, 10),
    pins: options.reorder ? [...pins].reverse() : pins,
    bounds: { minX: 8 + dx, minY: 8 + dy, maxX: 32 + dx, maxY: 12 + dy },
  }];

  const polygon = [p(17, 14), p(19, 14), p(19, 16), p(17, 16)];
  const pads: Pad[] = [
    {
      bounds: { minX: 16 + dx, minY: 14 + dy, maxX: 20 + dx, maxY: 16 + dy },
      side: 'top',
      net: options.rename ? 'NAMEN_SIND_IRRELEVANT' : 'SIG',
      shape: 'poly',
      width: 4,
      height: 2,
      angleDeg: 370,
      polygon: options.reorder ? rotate([...polygon].reverse(), 2) : polygon,
    },
    {
      bounds: { minX: 2 + dx, minY: 2 + dy, maxX: 6 + dx, maxY: 6 + dy },
      side: 'both',
      drill: 2,
      shape: 'round',
    },
  ];

  const vias: Via[] = [
    { position: p(12, 4), diameter: options.viaDiameter ?? 0.6, net: 'GND', layers: [] },
    { position: p(28, 16), diameter: 0.7, net: 'SIG', layers: [0, 1] },
  ];
  const nails: BoardData['nails'] = [
    { position: p(3, 17), side: 'top', net: 'TEST_A' },
    { position: p(37, 3), side: 'bottom', net: 'TEST_B' },
  ];

  return {
    format: options.rename ? 'IGNORED_FORMAT' : 'TEST',
    formatVersion: options.rename ? 'ignored-version' : '1',
    outline: orderedOutline,
    parts,
    nails: options.reorder ? [...nails].reverse() : nails,
    nets: new Map(options.rename ? [['anderer Name', { name: 'anderer Name', pinIndices: [] }]] : []),
    bounds: { minX: dx, minY: dy, maxX: 40 + dx, maxY: 20 + dy },
    pads: options.reorder ? [...pads].reverse() : pads,
    vias: options.reorder ? [...vias].reverse() : vias,
    traces: options.rename
      ? [{ start: p(-100, -100), end: p(100, 100), width: 99, net: 'ignorierter Pfad' }]
      : [],
  };
}

describe('computeSubboardKey', () => {
  it('ist deterministisch und verwendet SHA-256 plus Vorkommensindex', async () => {
    const board = makeBoard();
    const first = await computeSubboardKey(board);
    const second = await computeSubboardKey(board);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}#0$/);
    expect(await computeSubboardKey(board, 7)).toBe(`${first.slice(0, 64)}#7`);
  });

  it('ist unabhängig von Translation, Array-Reihenfolge, Konturstart und Konturrichtung', async () => {
    const original = makeBoard();
    const movedAndReordered = makeBoard({
      dx: 123.456,
      dy: -78.125,
      reorder: true,
      rename: true,
    });

    expect(await computeSubboardKey(movedAndReordered)).toBe(await computeSubboardKey(original));
  });

  it('reagiert auf eine relevante Geometrieänderung', async () => {
    const original = await computeSubboardKey(makeBoard());
    const changed = await computeSubboardKey(makeBoard({ viaDiameter: 0.9 }));

    expect(changed).not.toBe(original);
  });

  it('unterscheidet identische Pack-Geometrien über stabile Vorkommensindizes', async () => {
    const keys = await computeSubboardKeys([
      makeBoard(),
      makeBoard({ dx: 100, dy: 200, reorder: true, rename: true }),
      makeBoard({ viaDiameter: 0.9 }),
      makeBoard({ dx: -50, dy: 10 }),
    ]);

    expect(keys[0].slice(0, 64)).toBe(keys[1].slice(0, 64));
    expect(keys[0].slice(0, 64)).toBe(keys[3].slice(0, 64));
    expect(keys[2].slice(0, 64)).not.toBe(keys[0].slice(0, 64));
    expect(keys.map((key) => key.slice(65))).toEqual(['1', '2', '0', '0']);
  });

  it('ordnet identische, räumlich getrennte Subboards unabhängig von der Array-Reihenfolge zu', async () => {
    const left = makeBoard({ dx: 100, dy: 200 });
    const right = makeBoard({ dx: 200, dy: 200, reorder: true, rename: true });
    const forward = await computeSubboardKeys([left, right]);
    const reversed = await computeSubboardKeys([right, left]);
    const translated = await computeSubboardKeys([
      makeBoard({ dx: 150, dy: 180 }),
      makeBoard({ dx: 250, dy: 180, reorder: true, rename: true }),
    ]);

    expect(forward[0]).toBe(reversed[1]);
    expect(forward[1]).toBe(reversed[0]);
    expect(forward).toEqual(translated);
  });

  it('weist ungültige Vorkommensindizes zurück', async () => {
    await expect(computeSubboardKey(makeBoard(), -1)).rejects.toThrow(RangeError);
    await expect(computeSubboardKey(makeBoard(), 1.5)).rejects.toThrow(RangeError);
  });
});
