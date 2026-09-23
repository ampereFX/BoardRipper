import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const bitmap: FakeBitmap = {
    closed: false,
    close() {
      bitmap.closed = true;
    },
  };
  return bitmap as ImageBitmap & FakeBitmap;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function renderResponse(label: string): Response {
  return new Response(label, { status: 200, headers: { 'content-type': 'image/png' } });
}

const metadata = { id: 'asset', mimeType: 'image/png', widthPx: 100, heightPx: 50 };
const calibration: PhotoCalibration = { version: 1, points: [] };

function assetState(): BoardPhotoAssetState {
  return {
    mask: null,
    overlays: {
      top: { metadata, calibration },
      bottom: { metadata: { ...metadata, id: 'asset-bottom' }, calibration },
    },
  };
}

async function loadAsset(store: PhotoOverlayStore, boardKey = 'board'): Promise<void> {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, assetState()));
  await store.loadAsset(boardKey);
}

function resolveBitmapByResponseLabel(top: ImageBitmap, bottom: ImageBitmap): void {
  createImageBitmapMock.mockImplementation(async (blob: Blob) => {
    return (await blob.text()) === 'top' ? top : bottom;
  });
}

describe('PhotoOverlayStore concurrency', () => {
  it('übernimmt parallele Renderbilder von top und bottom', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);

    const topResponse = deferred<Response>();
    const bottomResponse = deferred<Response>();
    fetchMock.mockImplementation((url: string) => (
      url.includes('/top/render') ? topResponse.promise : bottomResponse.promise
    ));
    const top = bitmapSpy();
    const bottom = bitmapSpy();
    resolveBitmapByResponseLabel(top, bottom);

    const topLoad = store.loadRenderImage('board', 'top');
    const bottomLoad = store.loadRenderImage('board', 'bottom');
    topResponse.resolve(renderResponse('top'));
    bottomResponse.resolve(renderResponse('bottom'));

    await expect(Promise.all([topLoad, bottomLoad])).resolves.toEqual([top, bottom]);
    expect(store.getBoardState('board').sides.top.renderImage).toBe(top);
    expect(store.getBoardState('board').sides.bottom.renderImage).toBe(bottom);
    expect(top.closed).toBe(false);
    expect(bottom.closed).toBe(false);
  });

  it('verwirft nur die ältere Anfrage derselben Seite und schließt ihr Bitmap', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);

    const oldResponse = deferred<Response>();
    fetchMock
      .mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValueOnce(renderResponse('new'));
    const oldBitmap = bitmapSpy();
    const newBitmap = bitmapSpy();
    createImageBitmapMock.mockImplementation(async (blob: Blob) => (
      (await blob.text()) === 'new' ? newBitmap : oldBitmap
    ));

    const oldLoad = store.loadRenderImage('board', 'top');
    const newLoad = store.loadRenderImage('board', 'top');
    await expect(newLoad).resolves.toBe(newBitmap);
    oldResponse.resolve(renderResponse('old'));

    await expect(oldLoad).resolves.toBeNull();
    expect(oldBitmap.closed).toBe(true);
    expect(newBitmap.closed).toBe(false);
    expect(store.getBoardState('board').sides.top.renderImage).toBe(newBitmap);
  });

  it('invalidiert laufende Renderbilder bei releaseAll', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store, 'board-1');
    await loadAsset(store, 'board-2');

    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    fetchMock
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    const firstBitmap = bitmapSpy();
    const secondBitmap = bitmapSpy();
    createImageBitmapMock.mockImplementation(async (blob: Blob) => (
      (await blob.text()) === 'first' ? firstBitmap : secondBitmap
    ));

    const firstLoad = store.loadRenderImage('board-1', 'top');
    const secondLoad = store.loadRenderImage('board-2', 'bottom');
    store.releaseAll();
    firstResponse.resolve(renderResponse('first'));
    secondResponse.resolve(renderResponse('second'));

    await expect(Promise.all([firstLoad, secondLoad])).resolves.toEqual([null, null]);
    expect(firstBitmap.closed).toBe(true);
    expect(secondBitmap.closed).toBe(true);
  });

  it('invalidiert laufende Renderbilder bei einem Seiten-Update', async () => {
    const store = new PhotoOverlayStore();
    await loadAsset(store);

    const response = deferred<Response>();
    fetchMock.mockImplementationOnce(() => response.promise);
    const bitmap = bitmapSpy();
    createImageBitmapMock.mockResolvedValue(bitmap);

    const load = store.loadRenderImage('board', 'top');
    store.updateAfterDelete('board', 'top');
    response.resolve(renderResponse('stale'));

    await expect(load).resolves.toBeNull();
    expect(bitmap.closed).toBe(true);
    expect(store.getBoardState('board').sides.top.renderImage).toBeNull();
    expect(store.getBoardState('board').sides.top.renderImageStatus).toBe('idle');
  });
});
