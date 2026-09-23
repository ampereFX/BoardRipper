import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoOverlayApiError } from './api-client';
import type { BoardPhotoAssetState } from './api-client';
import { PhotoOverlayStore } from './overlay-store';
import type { PhotoCalibration } from './types';

const fetchMock = vi.fn();
const createImageBitmapMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('createImageBitmap', createImageBitmapMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  createImageBitmapMock.mockReset();
});

interface FakeBitmap {
  closed: boolean;
  close(): void;
}

function bitmapSpy(): ImageBitmap & FakeBitmap {
  const bmp: FakeBitmap = { closed: false, close() { bmp.closed = true; } };
  return bmp as ImageBitmap & FakeBitmap;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderResponse(): Response {
  return new Response('png-bytes', { status: 200, headers: { 'content-type': 'image/png' } });
}

const metadata = { id: 'a1', mimeType: 'image/png', widthPx: 100, heightPx: 50 };

function calibration(): PhotoCalibration {
  return {
    version: 1,
    points: [],
  };
}

function assetState(): BoardPhotoAssetState {
  return {
    mask: { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] },
    overlays: {
      top: { metadata, calibration: calibration() },
      bottom: { metadata: { ...metadata, id: 'a2' }, calibration: null },
    },
  };
}

async function loadAsset(store: PhotoOverlayStore, boardKey = 'b'): Promise<void> {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, assetState()));
  await store.loadAsset(boardKey);
}

describe('loadAsset', () => {
  it('lädt Metadaten, Kalibrierung und Maske', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);

    const board = store.getBoardState('b');
    expect(board.mask).toEqual(assetState().mask);
    expect(board.sides.top.status).toBe('ready');
    expect(board.sides.top.metadata).toEqual(metadata);
    expect(board.sides.top.calibration).toEqual(calibration());
    expect(board.sides.bottom.status).toBe('ready');
    expect(board.sides.bottom.calibration).toBeNull();
  });

  it('liefert bei 404 den leeren Zustand statt eines Fehlers', async () => {
    const store = new PhotoOverlayStore();
    fetchMock.mockResolvedValue(jsonResponse(404, 'not found'));

    await store.loadAsset('b');

    const board = store.getBoardState('b');
    expect(board.mask).toBeNull();
    expect(board.sides.top.status).toBe('ready');
    expect(board.sides.top.metadata).toBeNull();
    expect(board.sides.top.error).toBeNull();
  });

  it('legt API-Fehler im Zustand ab', async () => {
    const store = new PhotoOverlayStore();
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Datenbank kaputt' }));

    await store.loadAsset('b');

    expect(store.getBoardState('b').sides.top.status).toBe('error');
    const err = store.getBoardState('b').sides.top.error;
    expect(err).toBeInstanceOf(PhotoOverlayApiError);
    expect((err as PhotoOverlayApiError).status).toBe(500);
    expect(store.getBoardState('b').sides.bottom.status).toBe('error');
  });

  it('behält Renderbilder bei weiter existierendem Overlay und gibt sie frei, wenn es weg ist', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);
    const bmp = bitmapSpy();
    store.setRenderImage('b', 'top', bmp);

    // Neuer Asset-Stand ohne top-Overlay (z. B. anderswo gelöscht).
    const withoutTop = assetState();
    delete withoutTop.overlays.top;
    fetchMock.mockResolvedValue(jsonResponse(200, withoutTop));
    await store.loadAsset('b');

    expect(bmp.closed).toBe(true);
    expect(store.getBoardState('b').sides.top.renderImage).toBeNull();
    expect(store.getBoardState('b').sides.top.metadata).toBeNull();
  });
});

describe('loadRenderImage', () => {
  it('lädt, dekodiert und übernimmt das Render-Bild', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);
    const bmp = bitmapSpy();
    fetchMock.mockResolvedValue(renderResponse());
    createImageBitmapMock.mockResolvedValue(bmp);

    const result = await store.loadRenderImage('b', 'top');

    expect(result).toBe(bmp);
    expect(store.getBoardState('b').sides.top.renderImage).toBe(bmp);
    expect(store.getBoardState('b').sides.top.renderImageStatus).toBe('ready');
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/board-photo-assets/b/overlays/top/render',
      { credentials: 'same-origin' },
    );
  });

  it('tut nichts ohne Metadaten', async () => {
    const store = new PhotoOverlayStore();

    const result = await store.loadRenderImage('b', 'top');

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getBoardState('b').sides.top.renderImageStatus).toBe('idle');
  });

  it('setzt renderImageStatus auf error und legt den API-Fehler ab', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);
    fetchMock.mockResolvedValue(jsonResponse(404, 'missing'));

    await store.loadRenderImage('b', 'top');

    const side = store.getBoardState('b').sides.top;
    expect(side.renderImageStatus).toBe('error');
    expect(side.error).toBeInstanceOf(PhotoOverlayApiError);
    expect((side.error as PhotoOverlayApiError).status).toBe(404);
    expect(side.status).toBe('ready');
  });

  it('schließt das bisherige Bitmap bei Ersetzung durch ein neu geladenes', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);
    const old = bitmapSpy();
    store.setRenderImage('b', 'top', old);
    const fresh = bitmapSpy();
    fetchMock.mockResolvedValue(renderResponse());
    createImageBitmapMock.mockResolvedValue(fresh);

    await store.loadRenderImage('b', 'top');

    expect(old.closed).toBe(true);
    expect(store.getBoardState('b').sides.top.renderImage).toBe(fresh);
  });

  it('verwirft das Ergebnis einer veralteten Anfrage (Race) und schließt dessen Bitmap', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);
    let releaseFirstFetch!: () => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFirstFetch = () => resolve(renderResponse()); }))
      .mockResolvedValue(renderResponse());
    const winner = bitmapSpy();
    const loser = bitmapSpy();
    createImageBitmapMock
      .mockResolvedValueOnce(winner)
      .mockResolvedValueOnce(loser);

    const stale = store.loadRenderImage('b', 'top');
    // Erste Anfrage hängt beim fetch; die zweite läuft komplett durch und
    // erhöht die Generation, wodurch die erste veraltet.
    await expect(store.loadRenderImage('b', 'top')).resolves.toBe(winner);
    releaseFirstFetch();
    await expect(stale).resolves.toBeNull();

    expect(loser.closed).toBe(true);
    expect(store.getBoardState('b').sides.top.renderImage).toBe(winner);
    expect(winner.closed).toBe(false);
  });
});

describe('setRenderImage', () => {
  it('schließt das bisherige Bitmap bei Ersetzung', () => {
    const store = new PhotoOverlayStore();
    const first = bitmapSpy();
    const second = bitmapSpy();

    store.setRenderImage('b', 'top', first);
    store.setRenderImage('b', 'top', second);

    expect(first.closed).toBe(true);
    expect(store.getBoardState('b').sides.top.renderImage).toBe(second);
  });
});

describe('updateAfterImport / updateAfterCalibration / updateAfterDelete', () => {
  it('aktualisiert nach Import Metadaten und Kalibrierung', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);
    const newMetadata = { ...metadata, id: 'a3' };
    const cal = calibration();

    store.updateAfterImport('b', 'bottom', newMetadata, cal);

    const side = store.getBoardState('b').sides.bottom;
    expect(side.status).toBe('ready');
    expect(side.metadata).toEqual(newMetadata);
    expect(side.calibration).toBe(cal);
  });

  it('aktualisiert nach Rekalibrierung nur die Kalibrierung', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);
    const cal = calibration();

    store.updateAfterCalibration('b', 'top', cal);

    const side = store.getBoardState('b').sides.top;
    expect(side.calibration).toBe(cal);
    expect(side.metadata).toEqual(metadata);
  });

  it('schließt beim Löschen das Render-Bitmap und leert die Seite', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);
    const bmp = bitmapSpy();
    store.setRenderImage('b', 'top', bmp);

    store.updateAfterDelete('b', 'top');

    expect(bmp.closed).toBe(true);
    const side = store.getBoardState('b').sides.top;
    expect(side.metadata).toBeNull();
    expect(side.calibration).toBeNull();
    expect(side.renderImage).toBeNull();
    expect(side.renderImageStatus).toBe('idle');
    expect(side.status).toBe('ready');
  });
});

describe('Freigabe', () => {
  it('releaseBoard schließt alle Bitmaps und setzt den Zustand zurück', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);
    const top = bitmapSpy();
    const bottom = bitmapSpy();
    store.setRenderImage('b', 'top', top);
    store.setRenderImage('b', 'bottom', bottom);

    store.releaseBoard('b');

    expect(top.closed).toBe(true);
    expect(bottom.closed).toBe(true);
    const board = store.getBoardState('b');
    expect(board.mask).toBeNull();
    expect(board.sides.top.status).toBe('idle');
    expect(board.sides.top.renderImage).toBeNull();
  });

  it('releaseAll schließt Bitmaps aller Boards', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store, 'b1');
    await loadAsset(store, 'b2');
    const bmp1 = bitmapSpy();
    const bmp2 = bitmapSpy();
    store.setRenderImage('b1', 'top', bmp1);
    store.setRenderImage('b2', 'bottom', bmp2);

    store.releaseAll();

    expect(bmp1.closed).toBe(true);
    expect(bmp2.closed).toBe(true);
    expect(store.getBoardState('b1').sides.top.status).toBe('idle');
    expect(store.getBoardState('b2').sides.bottom.renderImage).toBeNull();
  });
});

describe('Subscription', () => {
  it('benachrichtigt Listener bei Zustandsänderungen', async () => {
    const store = new PhotoOverlayStore();
    const listener = vi.fn();
    store.subscribe(listener);

    await loadAsset(store);

    expect(listener).toHaveBeenCalledTimes(2); // loading + ready
  });
});
