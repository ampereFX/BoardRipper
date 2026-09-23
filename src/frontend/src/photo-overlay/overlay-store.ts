/**
 * Laufzeit-Store für PCB-Foto-Overlay-Metadaten und Renderbilder.
 *
 * Hält pro boardKey die geladenen Asset-Daten (Maske, Overlay-Metadaten und
 * Kalibrierung je Seite) sowie optional dekodierte Render-ImageBitmaps.
 * Rein laufzeitbezogen: kein localStorage, keine UI, keine Pixi-Ressourcen.
 *
 * Schreibzugriffe aufs Backend macht der api-client; danach werden die
 * Update-Methoden dieses Stores aufgerufen. Der Store ist Besitzer der
 * ImageBitmaps und schließt sie bei Ersetzung, Board-Freigabe und
 * Store-Freigabe.
 */

import { Emitter } from '../store/emitter';
import { buildOverlayUrl, getBoardPhotoAsset, PhotoOverlayApiError } from './api-client';
import type { BoardPhotoAssetState } from './api-client';
import type {
  ManualBoardMask,
  OverlayAssetMetadata,
  OverlaySide,
  PhotoCalibration,
} from './types';

/** Status eines Ladevorgangs. */
export type OverlayStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Laufzeit-Zustand einer Boardseite (top/bottom). */
export interface OverlaySideState {
  /** Asset-Daten geladen — unabhängig davon, ob ein Overlay existiert. */
  status: OverlayStatus;
  metadata: OverlayAssetMetadata | null;
  calibration: PhotoCalibration | null;
  /** Dekodiertes Render-Bild; Besitz beim Store (close() durch ihn). */
  renderImage: ImageBitmap | null;
  renderImageStatus: OverlayStatus;
  /** Letzter Fehler beim Laden von Asset-Daten oder Render-Bild. */
  error: Error | null;
}

/** Laufzeit-Zustand eines Boards, getrennt nach boardKey. */
export interface OverlayBoardState {
  mask: ManualBoardMask | null;
  sides: Record<OverlaySide, OverlaySideState>;
}

function emptySideState(): OverlaySideState {
  return {
    status: 'idle',
    metadata: null,
    calibration: null,
    renderImage: null,
    renderImageStatus: 'idle',
    error: null,
  };
}

function closeBitmap(bitmap: ImageBitmap | null | undefined): void {
  bitmap?.close();
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class PhotoOverlayStore extends Emitter {
  private _boards = new Map<string, OverlayBoardState>();
  /** Invalidiert laufende Asset-Metadaten-Ladevorgänge je Board. */
  private _assetGenerations = new Map<string, number>();
  /** Invalidiert laufende Renderbild-Ladevorgänge je Board und Seite. */
  private _renderGenerations = new Map<string, Map<OverlaySide, number>>();

  /** Aktueller Zustand eines Boards; erzeugt bei Bedarf einen leeren. */
  getBoardState(boardKey: string): OverlayBoardState {
    let state = this._boards.get(boardKey);
    if (!state) {
      state = { mask: null, sides: { top: emptySideState(), bottom: emptySideState() } };
      this._boards.set(boardKey, state);
    }
    return state;
  }

  private _bumpAsset(boardKey: string): number {
    const next = (this._assetGenerations.get(boardKey) ?? 0) + 1;
    this._assetGenerations.set(boardKey, next);
    return next;
  }

  private _bumpRender(boardKey: string, side: OverlaySide): number {
    let generations = this._renderGenerations.get(boardKey);
    if (!generations) {
      generations = new Map<OverlaySide, number>();
      this._renderGenerations.set(boardKey, generations);
    }
    const next = (generations.get(side) ?? 0) + 1;
    generations.set(side, next);
    return next;
  }

  private _bumpAllRenders(boardKey: string): void {
    this._bumpRender(boardKey, 'top');
    this._bumpRender(boardKey, 'bottom');
  }

  private _invalidateBoard(boardKey: string): void {
    this._bumpAsset(boardKey);
    this._bumpAllRenders(boardKey);
  }

  private _assetStale(boardKey: string, generation: number): boolean {
    return (this._assetGenerations.get(boardKey) ?? 0) !== generation;
  }

  private _renderStale(boardKey: string, side: OverlaySide, generation: number): boolean {
    return (this._renderGenerations.get(boardKey)?.get(side) ?? 0) !== generation;
  }

  /** Lädt Maske und Overlay-Metadaten vom Server. Ein 404 ergibt wie im
   *  api-client den leeren Zustand (status 'ready', ohne Metadaten).
   *  Renderbilder bleiben erhalten, solange das Overlay existiert; sonst
   *  werden sie geschlossen. */
  async loadAsset(boardKey: string): Promise<void> {
    const gen = this._bumpAsset(boardKey);
    this._bumpAllRenders(boardKey);
    const board = this.getBoardState(boardKey);
    for (const side of ['top', 'bottom'] as const) {
      const prev = board.sides[side];
      board.sides[side] = {
        ...prev,
        status: 'loading',
        renderImageStatus: prev.renderImage ? 'ready' : 'idle',
        error: null,
      };
    }
    this.notify();

    let asset: BoardPhotoAssetState;
    try {
      asset = await getBoardPhotoAsset(boardKey);
    } catch (err) {
      if (this._assetStale(boardKey, gen)) return;
      this._bumpAllRenders(boardKey);
      const error = toError(err);
      for (const side of ['top', 'bottom'] as const) {
        board.sides[side] = { ...board.sides[side], status: 'error', error };
      }
      this.notify();
      return;
    }
    if (this._assetStale(boardKey, gen)) return;
    this._bumpAllRenders(boardKey);

    for (const side of ['top', 'bottom'] as const) {
      const prev = board.sides[side];
      const stored = asset.overlays[side] ?? null;
      if (!stored) closeBitmap(prev.renderImage);
      board.sides[side] = {
        ...prev,
        status: 'ready',
        metadata: stored?.metadata ?? null,
        calibration: stored?.calibration ?? null,
        renderImage: stored ? prev.renderImage : null,
        renderImageStatus: stored && prev.renderImage ? 'ready' : 'idle',
        error: null,
      };
    }
    board.mask = asset.mask;
    this.notify();
  }

  /** Lädt und dekodiert das Render-Bild einer Seite. Vorher vorhandenes
   *  Bitmap wird bei Erfolg geschlossen. Gibt das Bitmap zurück oder null
   *  bei Fehler bzw. fehlenden Metadaten (Fehler liegt im Zustand). */
  async loadRenderImage(boardKey: string, side: OverlaySide): Promise<ImageBitmap | null> {
    const gen = this._bumpRender(boardKey, side);
    const board = this.getBoardState(boardKey);
    const prev = board.sides[side];
    if (!prev.metadata) return null;
    board.sides[side] = { ...prev, renderImageStatus: 'loading', error: null };
    this.notify();

    try {
      const res = await fetch(buildOverlayUrl(boardKey, side, 'render'), {
        credentials: 'same-origin',
      });
      if (!res.ok) {
        throw new PhotoOverlayApiError(
          res.status,
          null,
          `Render-Bild konnte nicht geladen werden (HTTP ${res.status})`,
        );
      }
      const bitmap = await createImageBitmap(await res.blob());
      if (this._renderStale(boardKey, side, gen)) {
        closeBitmap(bitmap);
        return null;
      }
      return this.setRenderImage(boardKey, side, bitmap);
    } catch (err) {
      if (this._renderStale(boardKey, side, gen)) return null;
      board.sides[side] = {
        ...board.sides[side],
        renderImageStatus: 'error',
        error: toError(err),
      };
      this.notify();
      return null;
    }
  }

  /** Übernimmt ein extern dekodiertes Render-Bild und schließt das
   *  bisherige. Gibt das übernommene Bitmap zurück. */
  setRenderImage(boardKey: string, side: OverlaySide, bitmap: ImageBitmap): ImageBitmap {
    this._bumpRender(boardKey, side);
    const board = this.getBoardState(boardKey);
    const prev = board.sides[side];
    closeBitmap(prev.renderImage);
    board.sides[side] = { ...prev, renderImage: bitmap, renderImageStatus: 'ready', error: null };
    this.notify();
    return bitmap;
  }

  /** Aktualisiert Metadaten und Kalibrierung nach einem Overlay-Import.
   *  Ein vorhandenes Render-Bild bleibt bis zum Austausch bestehen. */
  updateAfterImport(
    boardKey: string,
    side: OverlaySide,
    metadata: OverlayAssetMetadata,
    calibration: PhotoCalibration,
  ): void {
    this._bumpAsset(boardKey);
    this._bumpRender(boardKey, side);
    const board = this.getBoardState(boardKey);
    const prev = board.sides[side];
    board.sides[side] = {
      ...prev,
      status: 'ready',
      metadata,
      calibration,
      renderImageStatus: prev.renderImage ? 'ready' : 'idle',
      error: null,
    };
    this.notify();
  }

  /** Aktualisiert nur die Kalibrierung nach einer Rekalibrierung. */
  updateAfterCalibration(boardKey: string, side: OverlaySide, calibration: PhotoCalibration): void {
    this._bumpAsset(boardKey);
    this._bumpRender(boardKey, side);
    const board = this.getBoardState(boardKey);
    const prev = board.sides[side];
    board.sides[side] = {
      ...prev,
      calibration,
      renderImageStatus: prev.renderImage ? 'ready' : 'idle',
      error: null,
    };
    this.notify();
  }

  /** Räumt eine Seite nach Overlay-Löschung auf und schließt deren
   *  Render-Bitmap. Die Asset-Daten gelten als weiterhin geladen. */
  updateAfterDelete(boardKey: string, side: OverlaySide): void {
    this._bumpAsset(boardKey);
    this._bumpRender(boardKey, side);
    const board = this.getBoardState(boardKey);
    const prev = board.sides[side];
    closeBitmap(prev.renderImage);
    board.sides[side] = {
      ...prev,
      metadata: null,
      calibration: null,
      renderImage: null,
      renderImageStatus: 'idle',
      error: null,
    };
    this.notify();
  }

  /** Gibt alle Bitmaps eines Boards frei und vergisst dessen Zustand. */
  releaseBoard(boardKey: string): void {
    this._invalidateBoard(boardKey);
    const state = this._boards.get(boardKey);
    if (!state) return;
    closeBitmap(state.sides.top.renderImage);
    closeBitmap(state.sides.bottom.renderImage);
    this._boards.delete(boardKey);
    this.notify();
  }

  /** Schließt die CPU-Render-ImageBitmaps (Speicherfreigabe bei Szenenwechsel
   *  oder Deep-Pause), behält aber geladene Metadaten/Kalibrierung. boardKeys
   *  aus keep können übergeben werden, um z. B. das aktive Board auszunehmen. */
  releaseRenderImages(keep?: ReadonlySet<string>): void {
    let changed = false;
    for (const [boardKey, state] of this._boards) {
      if (keep?.has(boardKey)) continue;
      const top = state.sides.top;
      const bottom = state.sides.bottom;
      this._bumpRender(boardKey, 'top');
      this._bumpRender(boardKey, 'bottom');
      if (top.renderImage || top.renderImageStatus === 'loading') {
        closeBitmap(top.renderImage);
        state.sides.top = { ...top, renderImage: null, renderImageStatus: 'idle' };
        changed = true;
      }
      if (bottom.renderImage || bottom.renderImageStatus === 'loading') {
        closeBitmap(bottom.renderImage);
        state.sides.bottom = { ...bottom, renderImage: null, renderImageStatus: 'idle' };
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /** Gibt alle Bitmaps und den gesamten Store-Zustand frei. */
  releaseAll(): void {
    for (const boardKey of [...this._boards.keys()]) {
      this.releaseBoard(boardKey);
    }
  }
}

export const photoOverlayStore = new PhotoOverlayStore();
