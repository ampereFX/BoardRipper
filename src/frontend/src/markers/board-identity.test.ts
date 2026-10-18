import { describe, expect, it } from 'vitest';
import type { BoardData } from '../parsers/types';
import { computeSubboardKeys } from './subboard-key';
import { extractSubboards } from './subboard-geometry';
import { boardPointToRelative, makeBoardFileKey, relativeToBoardPoint, resolveBoardFileKey } from './board-identity';

function board(): BoardData {
  return {
    format: 'test', outline: [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }, { x: 10, y: 40 }],
    parts: [], nails: [], nets: new Map(),
    bounds: { minX: 10, minY: 20, maxX: 30, maxY: 40 },
  };
}

describe('board marker identity helpers', () => {
  it('uses the board-cache file identity format', () => {
    expect(makeBoardFileKey('layout.brd', 1234, 99)).toBe('layout.brd:1234:99');
  });

  it('prefers cache identity, then the cache triple, before the library id fallback', () => {
    const tab = { fileName: 'layout.brd', cacheKey: '', fileId: 42 };
    expect(resolveBoardFileKey(tab, [])).toBe('fileId:42');
    expect(resolveBoardFileKey(tab, [{ fileName: 'layout.brd', fileSize: 1234, fileLastModified: 99 }]))
      .toBe('layout.brd:1234:99');
    expect(resolveBoardFileKey({ ...tab, cacheKey: 'layout.brd:88:7' }, [
      { fileName: 'layout.brd', fileSize: 1234, fileLastModified: 99 },
    ])).toBe('layout.brd:88:7');
  });

  it('converts board locations to and from normalized bounds coordinates', () => {
    const value = board();
    const normalized = boardPointToRelative(value, { x: 20, y: 30 });
    expect(normalized).toEqual({ x: 0.5, y: 0.5 });
    expect(relativeToBoardPoint(value, normalized)).toEqual({ x: 20, y: 30 });
  });

  it('uses the shared photo subboard extraction before computing keys', async () => {
    const packed = {
      ...board(),
      nails: [
        { position: { x: 15, y: 30 }, side: 'top' as const, net: 'A' },
        { position: { x: 25, y: 30 }, side: 'top' as const, net: 'B' },
      ],
      boards: [
        { components: [], top: 0, sideSource: 'single' as const, bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 }, shift: { dx: 0, dy: 0 } },
        { components: [], top: 1, sideSource: 'single' as const, bounds: { minX: 20, minY: 0, maxX: 40, maxY: 20 }, shift: { dx: 0, dy: 0 } },
      ],
    };
    const extracted = extractSubboards(packed);
    const keys = await computeSubboardKeys(extracted.map((entry) => entry.board));
    expect(extracted).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
