import type { BoardData, Point } from '../parsers/types';
import { computeSubboardKeys } from './subboard-key';
import { extractSubboards } from './subboard-geometry';

export interface BoardBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface ResolvedMarkerIdentity {
  tabId: number;
  fileKey: string;
  subboardKey: string;
  bounds: BoardBounds;
}

/** Same file identity used by board-cache and file-view-prefs. */
export function makeBoardFileKey(name: string, size: number, lastModified: number): string {
  return `${name}:${size}:${lastModified}`;
}

export interface BoardFileIdentitySource {
  fileName: string;
  cacheKey: string;
  fileId?: number;
}

export interface BoardFileIdentityEntry {
  fileName: string;
  fileSize: number;
  fileLastModified: number;
}

/** Resolves a tab's file key with cache identity first and library id as fallback. */
export function resolveBoardFileKey(
  tab: BoardFileIdentitySource,
  entries: readonly BoardFileIdentityEntry[],
): string {
  if (tab.cacheKey) return tab.cacheKey;
  const entry = entries.find((item) => item.fileName === tab.fileName);
  if (entry && (entry.fileSize > 0 || entry.fileLastModified > 0)) {
    return makeBoardFileKey(entry.fileName, entry.fileSize, entry.fileLastModified);
  }
  if (tab.fileId != null) return `fileId:${tab.fileId}`;
  return `noCache:${tab.fileName}`;
}

export function boardPointToRelative(board: Pick<BoardData, 'bounds'>, point: Point): NormalizedPoint {
  const { minX, minY, maxX, maxY } = board.bounds;
  const width = maxX - minX;
  const height = maxY - minY;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new RangeError('Board-Bounds müssen eine positive Breite und Höhe haben.');
  }
  return { x: (point.x - minX) / width, y: (point.y - minY) / height };
}

export function relativeToBoardPoint(board: Pick<BoardData, 'bounds'>, point: NormalizedPoint): Point {
  const { minX, minY, maxX, maxY } = board.bounds;
  const width = maxX - minX;
  const height = maxY - minY;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new RangeError('Board-Bounds müssen eine positive Breite und Höhe haben.');
  }
  return { x: minX + point.x * width, y: minY + point.y * height };
}

const subboardKeyCache = new WeakMap<BoardData, Promise<string[]>>();

function keysForBoard(board: BoardData): Promise<string[]> {
  let keys = subboardKeyCache.get(board);
  if (!keys) {
    keys = computeSubboardKeys(extractSubboards(board).map((subboard) => subboard.board));
    subboardKeyCache.set(board, keys);
  }
  return keys;
}

/** Resolves a tab's stable file and geometric subboard identity without a photo backend. */
export async function resolveBoardIdentity(tabId: number, subboardIndex: number | null): Promise<ResolvedMarkerIdentity | null> {
  const { boardStore } = await import('../store/board-store');
  const tab = boardStore.tabs.find((item) => item.id === tabId);
  if (!tab?.board) return null;

  const board = tab.board;
  const pack = board.boards ?? [];
  const resolvedIndex = subboardIndex ?? tab.selectedBoardIndex ?? 0;
  const count = pack.length || 1;
  if (!Number.isInteger(resolvedIndex) || resolvedIndex < 0 || resolvedIndex >= count) return null;
  const keys = await keysForBoard(board);
  const entryBounds = pack[resolvedIndex]?.bounds ?? board.bounds;

  const fileKey = resolveBoardFileKey(tab, boardStore.openBoardEntries());
  return { tabId, fileKey, subboardKey: keys[resolvedIndex], bounds: entryBounds };
}
