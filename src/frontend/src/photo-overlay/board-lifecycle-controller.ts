/**
 * Board-Lifecycle-Controller für PCB-Foto-Overlays.
 *
 * Verbindet den bestehenden Board-/Tab-Lifecycle (BoardStore) mit der
 * PhotoOverlay-Infrastruktur, ohne UI oder Renderer zu berühren:
 *
 *  - Nach erfolgreichem Parse/Laden bekommt jedes physische Subboard
 *    (BoardData.boards; bei Einzeldateien das ganze Board) über
 *    computeSubboardKeys einen deterministischen boardKey. Geometrie-
 *    Fingerprint und Vorkommensindex bleiben reiner Laufzeitzustand dieses
 *    Controllers — BoardData wird nicht verändert oder serialisiert.
 *  - Direkt danach lädt der PhotoOverlayStore die Overlay-Metadaten pro Key.
 *    Fehler landen im OverlayStore-Zustand und blockieren weder Parsing
 *    noch Anzeige.
 *  - Beim Tab-Schließen werden die Keys des Tabs freigegeben (releaseBoard);
 *    ist kein Board-Tab mehr offen, gibt der Controller den ganzen Store
 *    frei (releaseAll). Keys, die ein anderer offener Tab noch hält, bleiben.
 *  - Beim Szenenwechsel (aktiver Tabwechsel) und wenn das Dokument in den
 *    Hintergrund geht, werden dekodierte CPU-ImageBitmaps geschlossen —
 *    geladene Metadaten und persistente Präferenzen bleiben erhalten.
 *  - Lite-/Offline-Builds haben kein Overlay-Backend: Der Controller liefert
 *    dort einen klaren disabled-Zustand und macht keine API-Aufrufe.
 */

import type { BoardData, Point } from '../parsers/types';
import { isLiteBuild, isOfflineBuild } from '../store/build-mode';
import { computeSubboardKeys } from './subboard-key';
import { photoOverlayStore } from './overlay-store';
import type { OverlaySideState, PhotoOverlayStore } from './overlay-store';
import type { OverlaySide } from './types';

type PackEntry = NonNullable<BoardData['boards']>[number];

/** Ein physisches Subboard als eigene BoardData-Geometrie. */
interface SubboardSource {
  /** Index in BoardData.boards; null bei Einzeldateien. */
  packIndex: number | null;
  name: string | null;
  board: BoardData;
}

/** Laufzeiteintrag pro offenem Board-Tab. */
interface TabOverlayEntry {
  tabId: number;
  board: BoardData | null;
  subboards: SubboardSource[];
  /** boardKeys je Subboard; null, solange die Hashes laufen oder der Build
   *  kein Overlay-Backend hat. */
  keys: string[] | null;
  /** Tab geschlossen oder ersetzt — Keys werden bei Ankunft freigegeben. */
  closed: boolean;
}

/** Ladestatus der Overlay-Asset-Daten einer Boardseite. */
export interface OverlaySideLifecycle {
  status: OverlaySideState['status'];
  /** Overlay-Metadaten vorhanden (d. h. es existiert ein Foto-Overlay). */
  hasMetadata: boolean;
  renderImageStatus: OverlaySideState['renderImageStatus'];
  error: string | null;
}

/** Ein physisches Subboard eines Tabs mit seinen Overlay-Zuständen. */
export interface OverlaySubboardLifecycle {
  /** Deterministischer boardKey; null, solange die Keys berechnet werden
   *  oder der Build kein Overlay-Backend hat. */
  boardKey: string | null;
  packIndex: number | null;
  name: string | null;
  /** top/bottom aus dem PhotoOverlayStore; null, solange kein Key existiert. */
  sides: Record<OverlaySide, OverlaySideLifecycle> | null;
}

/** Stabiler Zugriffspunkt für spätere UI/Renderer: Overlay-Zustand eines Tabs. */
export interface OverlayTabLifecycle {
  tabId: number;
  /** 'disabled' = Lite-/Offline-Build (kein Backend), 'pending' = Keys werden
   *  berechnet, 'ready' = Keys + Metadatenladung angestoßen, 'empty' = kein
   *  Board im Tab. */
  status: 'disabled' | 'pending' | 'ready' | 'empty';
  /** Grund, wenn status 'disabled' ist. */
  reason: 'lite' | 'offline' | null;
  /** Index des im Tab ausgewählten Subboards (null = alle/keine Auswahl). */
  activeSubboardIndex: number | null;
  subboards: OverlaySubboardLifecycle[];
}

function pointInBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  x: number,
  y: number,
): boolean {
  const pad = 0.5;
  return x >= bounds.minX - pad && x <= bounds.maxX + pad && y >= bounds.minY - pad && y <= bounds.maxY + pad;
}

/** Outline-Subpfade (NaN-getrennt) behalten, deren erster Punkt in den
 *  Subboard-Bounds liegt — gleiche Konvention wie derive-board-view. */
function filterOutlineByBounds(outline: Point[], inSub: (x: number, y: number) => boolean): Point[] {
  const kept: Point[] = [];
  let sub: Point[] = [];
  let keep = false;
  const flush = () => {
    if (keep && sub.length > 0) {
      if (kept.length > 0) kept.push({ x: NaN, y: NaN });
      kept.push(...sub);
    }
    sub = [];
    keep = false;
  };
  for (const p of outline) {
    if (Number.isNaN(p.x) || Number.isNaN(p.y)) {
      flush();
      continue;
    }
    if (sub.length === 0) keep = inSub(p.x, p.y);
    sub.push(p);
  }
  flush();
  return kept;
}

/** Extrahiert die Geometrie eines physischen Subboards aus einem Pack, damit
 *  computeSubboardKeys sie wie ein eigenständiges Board hashen kann. */
function extractSubboard(board: BoardData, entry: PackEntry, index: number): BoardData {
  const bounds = entry.bounds;
  const inSub = (x: number, y: number): boolean => pointInBounds(bounds, x, y);

  const parts = board.parts.filter((part) =>
    (part.boardIndex ?? (inSub(part.origin.x, part.origin.y) ? index : -1)) === index,
  );
  const nails = board.nails.filter((nail) => inSub(nail.position.x, nail.position.y));
  const vias = board.vias?.filter((via) => inSub(via.position.x, via.position.y));
  const pads = board.pads?.filter((pad) =>
    inSub((pad.bounds.minX + pad.bounds.maxX) / 2, (pad.bounds.minY + pad.bounds.maxY) / 2),
  );

  return {
    ...board,
    outline: filterOutlineByBounds(board.outline, inSub),
    parts,
    nails,
    vias,
    pads,
    bounds,
  };
}

/** Physische Subboards einer BoardData: bei Packs je Eintrag aus
 *  BoardData.boards, bei Einzeldateien das ganze Board. */
function extractSubboards(board: BoardData): SubboardSource[] {
  const pack = board.boards ?? [];
  if (pack.length === 0) return [{ packIndex: null, name: null, board }];
  return pack.map((entry, index) => ({
    packIndex: index,
    name: entry.name ?? null,
    board: extractSubboard(board, entry, index),
  }));
}

function toSideLifecycle(side: OverlaySideState): OverlaySideLifecycle {
  return {
    status: side.status,
    hasMetadata: side.metadata != null,
    renderImageStatus: side.renderImageStatus,
    error: side.error?.message ?? null,
  };
}

export class BoardLifecycleController {
  private readonly _store: PhotoOverlayStore;
  private readonly _entries = new Map<number, TabOverlayEntry>();
  /** Liefert selectedBoardIndex eines Tabs (null = keine Auswahl). Wird vom
   *  BoardStore gesetzt, damit 'active' ohne Import-Zyklus auflöst. */
  private _selectedBoardIndexProvider: ((tabId: number) => number | null) | null = null;

  constructor(store: PhotoOverlayStore = photoOverlayStore) {
    this._store = store;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
  }

  /** Dokument im Hintergrund (Deep-Pause-Deckung): alle Render-Bitmaps
   *  schließen. Metadaten bleiben geladen. */
  private _onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this._store.releaseRenderImages();
    }
  };

  setSelectedBoardIndexProvider(provider: ((tabId: number) => number | null) | null): void {
    this._selectedBoardIndexProvider = provider;
  }

  private _disabledReason(): 'lite' | 'offline' | null {
    if (!isLiteBuild()) return null;
    return isOfflineBuild() ? 'offline' : 'lite';
  }

 /** Nach erfolgreichem Parse/Laden: Keys berechnen und Metadaten laden.
  *  Fire-and-forget für den Aufrufer — der Rückgabewert ist für Tests da;
  *  Fehler blockieren niemals den Board-Ladevorgang. */
  async attachBoard(tabId: number, board: BoardData | null): Promise<void> {
    const existing = this._entries.get(tabId);
    if (existing && !existing.closed && existing.board === board) return;
    if (existing) {
      existing.closed = true;
      this._releaseEntryKeys(existing);
    }

    const entry: TabOverlayEntry = {
      tabId,
      board,
      subboards: board ? extractSubboards(board) : [],
      keys: null,
      closed: false,
    };
    this._entries.set(tabId, entry);
    if (!board || this._disabledReason() !== null) return;
    await this._assignKeys(entry);
  }

  private async _assignKeys(entry: TabOverlayEntry): Promise<void> {
    let keys: string[];
    try {
      keys = await computeSubboardKeys(entry.subboards.map((s) => s.board));
    } catch {
      // computeSubboardKeys wirft nur bei ungültigen Indizes — das Board
      // bleibt auch dann voll nutzbar, nur ohne Overlay-Laufzeitzustand.
      return;
    }
    if (entry.closed) {
      this._releaseEntryKeys(entry, keys);
      this._entries.delete(entry.tabId);
      this._maybeReleaseAll();
      return;
    }
    entry.keys = keys;
    for (const key of keys) {
      try {
        await this._store.loadAsset(key);
      } catch {
        // Fehler steht im OverlayStore-Zustand (side.status === 'error');
        // das Board darf durch Overlay-Probleme nie blockiert werden.
      }
    }
  }

  /** Tab geschlossen: Keys freigeben, die kein anderer offener Tab noch hält. */
  releaseBoardTab(tabId: number): void {
    const entry = this._entries.get(tabId);
    if (!entry) return;
    entry.closed = true;
    if (entry.keys) {
      this._releaseEntryKeys(entry);
      this._entries.delete(tabId);
    }
    this._maybeReleaseAll();
  }

  /** Szenenwechsel: Render-Bitmaps aller inaktiven Boards schließen; das
   *  aktive Board und alle Metadaten bleiben erhalten. */
  onActiveTabChanged(activeTabId: number | null): void {
    const keep = new Set<string>();
    if (activeTabId != null) {
      const entry = this._entries.get(activeTabId);
      if (entry?.keys) for (const key of entry.keys) keep.add(key);
    }
    this._store.releaseRenderImages(keep);
  }

  /** Öffentlicher Deep-Pause-Anknüpfpunkt (z. B. für den Renderer in einer
   *  späteren Phase): CPU-ImageBitmaps freigeben, Metadaten behalten. */
  releaseCpuRenderImages(keepBoardKeys?: ReadonlySet<string>): void {
    this._store.releaseRenderImages(keepBoardKeys);
  }

  getLifecycle(tabId: number): OverlayTabLifecycle | null {
    const entry = this._entries.get(tabId);
    if (!entry) return null;
    const reason = this._disabledReason();
    const status: OverlayTabLifecycle['status'] =
      reason !== null ? 'disabled' : !entry.board ? 'empty' : entry.keys ? 'ready' : 'pending';

    const subboards: OverlaySubboardLifecycle[] = entry.subboards.map((sub, index) => {
      const boardKey = entry.keys?.[index] ?? null;
      const sides = boardKey
        ? (() => {
            const state = this._store.getBoardState(boardKey);
            return { top: toSideLifecycle(state.sides.top), bottom: toSideLifecycle(state.sides.bottom) };
          })()
        : null;
      return { boardKey, packIndex: sub.packIndex, name: sub.name, sides };
    });

    const activeIndex = this._selectedBoardIndexProvider?.(tabId) ?? null;
    return {
      tabId,
      status,
      reason,
      activeSubboardIndex:
        activeIndex != null && activeIndex >= 0 && activeIndex < subboards.length ? activeIndex : null,
      subboards,
    };
  }

  /** boardKey eines Subboards. 'active' löst über die Tab-Auswahl auf
   *  (Einzeldateien und ohne Auswahl: das erste Subboard). */
  getSubboardKey(tabId: number, subboardIndex: number | 'active' | null = 'active'): string | null {
    const entry = this._entries.get(tabId);
    if (!entry?.keys) return null;
    const index = this._resolveSubboardIndex(entry, subboardIndex);
    return index != null ? entry.keys[index] ?? null : null;
  }

  private _resolveSubboardIndex(
    entry: TabOverlayEntry,
    requested: number | 'active' | null,
  ): number | null {
    const count = entry.subboards.length;
    if (count === 0) return null;
    if (typeof requested === 'number') {
      return requested >= 0 && requested < count ? requested : null;
    }
    if (requested === null) return 0;
    // 'active': bei Einzeldateien das eine Board, bei Packs die Tab-Auswahl.
    if (!entry.board?.boards || entry.board.boards.length === 0) return 0;
    const selected = this._selectedBoardIndexProvider?.(entry.tabId) ?? null;
    return selected != null && selected >= 0 && selected < count ? selected : 0;
  }

  /** Keys eines (geschlossenen/ersetzten) Tabs freigeben; Keys, die andere
   *  offene Tabs noch halten, bleiben — identische Geometrie teilt sich
   *  absichtlich einen boardKey. */
  private _releaseEntryKeys(entry: TabOverlayEntry, keys: string[] | null = entry.keys): void {
    if (!keys) return;
    const stillUsed = new Set<string>();
    for (const other of this._entries.values()) {
      if (other === entry || other.closed || !other.keys) continue;
      for (const key of other.keys) stillUsed.add(key);
    }
    for (const key of keys) {
      if (!stillUsed.has(key)) this._store.releaseBoard(key);
    }
  }

  /** Endgültige Freigabe: kein offener Board-Tab mehr → ganzen Store leeren. */
  private _maybeReleaseAll(): void {
    if ([...this._entries.values()].some((e) => !e.closed)) return;
    this._store.releaseAll();
  }

  /** Test-/Aufräumhilfe: Listener abhängen und Laufzeitzustand verwerfen. */
  dispose(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    this._entries.clear();
    this._selectedBoardIndexProvider = null;
  }
}

export const boardLifecycleController = new BoardLifecycleController();
