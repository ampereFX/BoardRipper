import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoOverlayApiError } from './api-client';
import type { BoardPhotoAssetState } from './api-client';
import { BoardLifecycleController } from './board-lifecycle-controller';
import { PhotoOverlayStore } from './overlay-store';
import type { BoardData } from '../parsers/types';
import { computeSubboardKey } from './subboard-key';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeBoard(xOffset = 0, format = 'TEST'): BoardData {
  const p = (x: number, y: number) => ({ x: x + xOffset, y });
  // Kompaktes Einzeldatei-Board: ein Outline-Loop, ein Part, ein Nail.
  return {
    format,
    outline: [p(0, 0), p(40, 0), p(40, 20), p(0, 20)],
    parts: [{
      name: 'U1',
      side: 'top',
      type: 'smd',
      origin: p(10, 10),
      pins: [{
        name: 'A1', number: '1', position: p(10, 10), radius: 1, side: 'top', net: 'GND',
      }],
      bounds: { minX: xOffset + 8, minY: 8, maxX: xOffset + 12, maxY: 12 },
    }],
    nails: [{ position: p(3, 17), side: 'top', net: 'TEST_A' }],
    nets: new Map(),
    bounds: { minX: xOffset, minY: 0, maxX: xOffset + 40, maxY: 20 },
  };
}

/** Zwei Einzeldatei-Boards (mit Versatz) zu einem Pack zusammenfügen —
 *  so wie der XZZ-Parser die Subboards nebeneinander legt. */
function makePackBoard(): BoardData {
  const sub0 = makeBoard(0, 'AP');
  const sub1 = makeBoard(100, 'BB');
  const pack: BoardData = {
    format: 'PACK',
    outline: [...sub0.outline, { x: NaN, y: NaN }, ...sub1.outline],
    parts: [...sub0.parts, ...sub1.parts],
    nails: [...sub0.nails, ...sub1.nails],
    nets: new Map(),
    bounds: { minX: 0, minY: 0, maxX: 140, maxY: 20 },
    boards: [
      { components: [0, 1], top: 0, sideSource: 'cpu', bounds: { minX: 0, minY: 0, maxX: 40, maxY: 20 }, shift: { dx: 0, dy: 0 }, name: 'AP' },
      { components: [2, 3], top: 2, bottom: 3, sideSource: 'cpu', bounds: { minX: 100, minY: 0, maxX: 140, maxY: 20 }, shift: { dx: 0, dy: 0 }, name: 'BB' },
    ],
  };
  return pack;
}

function readyAsset(): BoardPhotoAssetState {
  return { mask: null, overlays: {} };
}

/** Vollständiges Board, dessen beide Subboards exakt dieselbe Geometrie
 *  tragen (zweites Part liegt im selben Bounds-Fenster) → identischer
 *  Fingerprint, occurrence index unterscheidet die Subboards. */
function makeIdenticalPackBoard(): BoardData {
  const pack = makePackBoard();
  // Subboard 1 auf dasselbe Bounds-Fenster wie Subboard 0 legen: alle
  // Geometrie (ein Loop 0..40, Part bei 10,10, Nail bei 3,17) liegt dann in
  // beiden Fenstern → beide Subboards hashen identische Geometrie.
  pack.boards![1] = { ...pack.boards![1], bounds: { minX: 0, minY: 0, maxX: 40, maxY: 20 } };
  return pack;
}

describe('BoardLifecycleController — Key-Zuordnung nach Parse', () => {
  it('berechnet für jedes Subboard eines Packs den deterministischen Key', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, readyAsset())));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);
    const board = makeIdenticalPackBoard();

    await controller.attachBoard(1, board);

    // Referenz: makeBoard() bildet die Pack-Geometrie ab. extractSubboard
    // behält bei deckenden Bounds die volle Geometrie, also stimmen die
    // Fingerprints mit dem ganzen Board überein; nur der occurrence index
    // unterscheidet die Subboards.
    const key0 = controller.getSubboardKey(1, 0)!;
    const key1 = controller.getSubboardKey(1, 1)!;
    // Pack-Keys sind deterministisch: gleiches Board → gleiche Keys.
    const store2 = new PhotoOverlayStore();
    const controller2 = new BoardLifecycleController(store2);
    await controller2.attachBoard(1, board);
    expect(controller2.getSubboardKey(1, 0)).toBe(key0);
    expect(controller2.getSubboardKey(1, 1)).toBe(key1);
    // Beide Subboards haben dieselbe Geometrie (identische Bounds-Fenster
    // über dieselbe Geometrie) → gleicher Fingerprint, verschiedener Index.
    expect(key0.slice(0, 64)).toBe(key1.slice(0, 64));
    expect(key0.endsWith('#0')).toBe(true);
    expect(key1.endsWith('#1')).toBe(true);
    controller2.dispose();
    expect(controller.getLifecycle(1)?.status).toBe('ready');
    controller.dispose();
  });

  it('bildet Einzeldateien als ein Subboard ab', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, readyAsset())));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);
    const board = makeBoard();

    await controller.attachBoard(1, board);

    const key = controller.getSubboardKey(1);
    expect(key).toBe(await computeSubboardKey(board));
    expect(controller.getLifecycle(1)?.subboards).toHaveLength(1);
    controller.dispose();
  });
});

describe('BoardLifecycleController — Metadaten laden nach Parse', () => {
  it('ruft loadAsset je Key auf und Metadaten sind über den Store erreichbar', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, readyAsset()));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    const p = controller.attachBoard(1, makeBoard());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await p;
    const key = controller.getSubboardKey(1)!;
    const state = store.getBoardState(key);
    expect(state.sides.top.status).toBe('ready');
    expect(state.sides.bottom.status).toBe('ready');
    const lifecycle = controller.getLifecycle(1)!;
    expect(lifecycle.subboards[0].sides!.top.status).toBe('ready');
    expect(lifecycle.subboards[0].sides!.top.hasMetadata).toBe(false);
    controller.dispose();
  });

  it('lädt Metadaten, wenn der Server welche hat', async () => {
    const asset: BoardPhotoAssetState = {
      mask: null,
      overlays: {
        top: {
          metadata: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', mimeType: 'image/jpeg', widthPx: 100, heightPx: 50 },
          calibration: null,
        },
      },
    };
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, asset)));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    await controller.attachBoard(1, makeBoard());
    const state = store.getBoardState(controller.getSubboardKey(1)!);
    expect(state.sides.top.metadata?.mimeType).toBe('image/jpeg');
    expect(state.sides.bottom.metadata).toBeNull();
    controller.dispose();
  });
});

describe('BoardLifecycleController — nicht blockierende Fehler', () => {
  it('lässt API-Fehler nicht an attachBoard hochsteigen und legt sie im Zustand ab', async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(new PhotoOverlayApiError(500, null, 'Server kaputt')));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    await expect(controller.attachBoard(1, makeBoard())).resolves.toBeUndefined();
    const lifecycle = controller.getLifecycle(1)!;
    expect(lifecycle.status).toBe('ready');
    expect(lifecycle.subboards[0].sides!.top.status).toBe('error');
    expect(lifecycle.subboards[0].sides!.top.error).toContain('Server kaputt');
    controller.dispose();
  });

  it('berechnet Keys trotzdem weiter, wenn loadAsset wirft', async () => {
    let calls = 0;
    fetchMock.mockImplementation(() => {
      calls++;
      return Promise.reject(new PhotoOverlayApiError(0, null, 'Netzwerk weg'));
    });
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    await controller.attachBoard(1, makePackBoard());
    expect(calls).toBe(2);
    expect(controller.getSubboardKey(1, 0)).not.toBeNull();
    expect(controller.getSubboardKey(1, 1)).not.toBeNull();
    controller.dispose();
  });
});

describe('BoardLifecycleController — Tab-Close / Deep-Pause-Freigabe', () => {
  it('releaseBoardTab gibt Board-Zustände frei (releaseBoard)', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, readyAsset())));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    await controller.attachBoard(1, makeBoard());
    const key = controller.getSubboardKey(1)!;
    store.setRenderImage(key, 'top', bitmapSpy());

    controller.releaseBoardTab(1);
    expect(store.getBoardState(key).sides.top.renderImageStatus).toBe('idle');
    // releaseBoard hat den Zustand des Keys gelöscht — ein getBoardState
    // erzeugt einen frischen leeren Zustand.
    expect(store.getBoardState(key).sides.top.status).toBe('idle');
    controller.dispose();
  });

  it('gibt den ganzen Store frei (releaseAll), wenn der letzte Tab schließt', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, readyAsset())));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    await controller.attachBoard(1, makeBoard());
    await controller.attachBoard(2, makeBoard(100));
    const key1 = controller.getSubboardKey(1)!;
    const key2 = controller.getSubboardKey(2)!;
    const bmp = store.setRenderImage(key1, 'top', bitmapSpy());

    controller.releaseBoardTab(1);
    // Tab 2 ist noch offen — Key1-Zustand bleibt (wird vom Store gehalten,
    // aber Tab-1-fremd). Wichtig: releaseAll darf noch nicht laufen.
    expect(store.getBoardState(key2).sides.top.status).toBe('ready');
    controller.releaseBoardTab(2);
    // releaseAll hat alle Bitmaps geschlossen.
    expect(isClosed(bmp)).toBe(true);
    controller.dispose();
  });

  it('releaseAll schließt auch Bitmaps identischer Subboards genau einmal', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, readyAsset())));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    await controller.attachBoard(1, makeBoard());
    const key = controller.getSubboardKey(1)!;
    const bmp = store.setRenderImage(key, 'top', bitmapSpy());

    controller.releaseBoardTab(1);
    expect(isClosed(bmp)).toBe(true);
    controller.dispose();
  });

  it('onActiveTabChanged schließt Bitmaps inaktiver Boards und hält die aktiven', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, readyAsset())));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    await controller.attachBoard(1, makeBoard());
    await controller.attachBoard(2, makeBoard(100));
    const key1 = controller.getSubboardKey(1)!;
    const key2 = controller.getSubboardKey(2)!;
    const bmp1 = store.setRenderImage(key1, 'top', bitmapSpy());
    const bmp2 = store.setRenderImage(key2, 'top', bitmapSpy());

    controller.onActiveTabChanged(2);
    expect(isClosed(bmp1)).toBe(true);
    expect(isClosed(bmp2)).toBe(false);
    // Metadaten-Zustand bleibt geladen.
    expect(store.getBoardState(key1).sides.top.status).toBe('ready');
    controller.dispose();
  });

  it('releaseCpuRenderImages schließt Bitmaps, behält Metadaten', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, readyAsset())));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    await controller.attachBoard(1, makeBoard());
    const key = controller.getSubboardKey(1)!;
    const bmp = store.setRenderImage(key, 'bottom', bitmapSpy());

    controller.releaseCpuRenderImages();
    expect(isClosed(bmp)).toBe(true);
    expect(store.getBoardState(key).sides.bottom.metadata).toBeNull();
    expect(store.getBoardState(key).sides.bottom.renderImageStatus).toBe('idle');
    controller.dispose();
  });

  it('ein geteiltes Board bleibt erhalten, wenn nur einer von zwei Tabs schließt', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, readyAsset())));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    // Zwei Tabs, exakt dieselbe BoardData-Geometrie → gleicher boardKey.
    await controller.attachBoard(1, makeBoard());
    const board2 = makeBoard();
    await controller.attachBoard(2, board2);
    const key1 = controller.getSubboardKey(1)!;
    const key2 = controller.getSubboardKey(2)!;
    expect(key1).toBe(key2);

    controller.releaseBoardTab(1);
    // Tab 2 hält denselben Key weiter — der Zustand überlebt.
    expect(controller.getSubboardKey(2)).toBe(key2);
    controller.releaseBoardTab(2);
    controller.dispose();
  });
});

describe('BoardLifecycleController — Offline/Lite deaktiviert', () => {
  it.each(['lite', 'offline'] as const)('ist im %s-Build disabled und ruft die API nicht auf', async (mode) => {
    vi.stubEnv('MODE', mode);
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    await controller.attachBoard(1, makeBoard());

    expect(fetchMock).not.toHaveBeenCalled();
    const lifecycle = controller.getLifecycle(1)!;
    expect(lifecycle.status).toBe('disabled');
    expect(lifecycle.reason).toBe(mode);
    expect(controller.getSubboardKey(1)).toBeNull();
    expect(lifecycle.subboards[0].boardKey).toBeNull();
    expect(lifecycle.subboards[0].sides).toBeNull();
    vi.unstubAllEnvs();
    controller.dispose();
  });
});

describe('BoardLifecycleController — aktives Subboard', () => {
  it('löst "active" über die Tab-Auswahl auf und kennt activeSubboardIndex', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, readyAsset())));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);
    controller.setSelectedBoardIndexProvider(() => 1);

    await controller.attachBoard(1, makePackBoard());

    expect(controller.getSubboardKey(1)).toBe(controller.getSubboardKey(1, 1));
    const lifecycle = controller.getLifecycle(1)!;
    expect(lifecycle.activeSubboardIndex).toBe(1);
    expect(lifecycle.subboards[1].name).toBe('BB');
    controller.dispose();
  });

  it('löst "active" ohne Auswahl auf das erste Subboard auf', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, readyAsset())));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);

    await controller.attachBoard(1, makePackBoard());

    expect(controller.getSubboardKey(1)).toBe(controller.getSubboardKey(1, 0));
    expect(controller.getLifecycle(1)?.activeSubboardIndex).toBeNull();
    controller.dispose();
  });
});

interface FakeBitmap extends ImageBitmap {
  readonly closed: boolean;
}

function bitmapSpy(): ImageBitmap & FakeBitmap {
  let closed = false;
  const bmp = {
    get closed() { return closed; },
    close() { closed = true; },
  };
  return bmp as ImageBitmap & FakeBitmap;
}

function isClosed(bmp: ImageBitmap): boolean {
  return (bmp as ImageBitmap & FakeBitmap).closed;
}

describe('BoardLifecycleController — occurrence index für identische Subboards', () => {

  it('erzeugt identische Keys für identische Subboards mit fortlaufendem occurrence index', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, readyAsset())));
    const store = new PhotoOverlayStore();
    const controller = new BoardLifecycleController(store);
    const packBoard = makeIdenticalPackBoard();

    await controller.attachBoard(1, packBoard);

    const key0 = controller.getSubboardKey(1, 0);
    const key1 = controller.getSubboardKey(1, 1);
    expect(key0).not.toBeNull();
    expect(key1).not.toBeNull();
    expect(key0!.slice(0, 64)).toBe(key1!.slice(0, 64));
    expect(key0).toMatch(/#0$/);
    expect(key1).toMatch(/#1$/);
    controller.dispose();
  });
});
