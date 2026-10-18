import type { BoardData, Point } from '../parsers/types';

type PackBoard = NonNullable<BoardData['boards']>[number];

/** A physical subboard and its source index inside a parsed pack. */
export interface SubboardSource {
  packIndex: number | null;
  name: string | null;
  board: BoardData;
}

function pointInBounds(bounds: BoardData['bounds'], x: number, y: number): boolean {
  const pad = 0.5;
  return x >= bounds.minX - pad && x <= bounds.maxX + pad && y >= bounds.minY - pad && y <= bounds.maxY + pad;
}

function filterOutlineByBounds(outline: Point[], inSub: (x: number, y: number) => boolean): Point[] {
  const kept: Point[] = [];
  let current: Point[] = [];
  let keep = false;
  const flush = () => {
    if (keep && current.length > 0) {
      if (kept.length > 0) kept.push({ x: NaN, y: NaN });
      kept.push(...current);
    }
    current = [];
    keep = false;
  };
  for (const point of outline) {
    if (Number.isNaN(point.x) || Number.isNaN(point.y)) {
      flush();
      continue;
    }
    if (current.length === 0) keep = inSub(point.x, point.y);
    current.push(point);
  }
  flush();
  return kept;
}

/** Extracts a pack member using the same ownership rules as photo overlays. */
export function extractSubboard(board: BoardData, entry: PackBoard, index: number): BoardData {
  const bounds = entry.bounds;
  const inSub = (x: number, y: number) => pointInBounds(bounds, x, y);
  return {
    ...board,
    bounds,
    outline: filterOutlineByBounds(board.outline, inSub),
    parts: board.parts.filter((part) => (part.boardIndex ?? (inSub(part.origin.x, part.origin.y) ? index : -1)) === index),
    nails: board.nails.filter((nail) => inSub(nail.position.x, nail.position.y)),
    vias: board.vias?.filter((via) => inSub(via.position.x, via.position.y)),
    pads: board.pads?.filter((pad) => inSub((pad.bounds.minX + pad.bounds.maxX) / 2, (pad.bounds.minY + pad.bounds.maxY) / 2)),
  };
}

/** Physical subboards: pack members, or the whole board for a single-board file. */
export function extractSubboards(board: BoardData): SubboardSource[] {
  const pack = board.boards ?? [];
  if (pack.length === 0) return [{ packIndex: null, name: null, board }];
  return pack.map((entry, index) => ({
    packIndex: index,
    name: entry.name ?? null,
    board: extractSubboard(board, entry, index),
  }));
}
