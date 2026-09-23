import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOverlayUrl,
  deleteBoardPhotoOverlay,
  getBoardPhotoAsset,
  PhotoOverlayApiError,
  putBoardPhotoCalibration,
  putBoardPhotoMask,
  putBoardPhotoOverlay,
} from './api-client';
import type { CalibrationPointPair, PhotoCalibration } from './types';

const fetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function jsonResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, { status, headers: { 'content-type': contentType } });
}

function calibration(): PhotoCalibration {
  const pair: CalibrationPointPair = {
    id: 1,
    board: { x: 0.1, y: 0.1 },
    photo: { x: 0.2, y: 0.2 },
  };
  return {
    version: 1,
    points: [pair],
  };
}

describe('getBoardPhotoAsset', () => {
  it('lädt den Zustand und encodiert den boardKey in der URL', async () => {
    const state = {
      mask: null,
      overlays: {
        top: {
          metadata: { id: 'a1', mimeType: 'image/jpeg', widthPx: 100, heightPx: 50 },
          calibration: null,
        },
      },
    };
    fetchMock.mockResolvedValue(jsonResponse(200, state));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getBoardPhotoAsset('board a/b')).resolves.toEqual(state);

    expect(fetchMock).toHaveBeenCalledWith('/api/board-photo-assets/board%20a%2Fb', {
      credentials: 'same-origin',
    });
  });

  it('liefert den leeren Zustand für ein unbekanntes Asset (404)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, 'not found', 'text/plain'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getBoardPhotoAsset('x')).resolves.toEqual({ mask: null, overlays: {} });
  });

  it('wirft einen Fehler mit Status und Servermeldung', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Datenbank kaputt' }));
    vi.stubGlobal('fetch', fetchMock);

    const err = await getBoardPhotoAsset('x').catch((e) => e);
    expect(err).toBeInstanceOf(PhotoOverlayApiError);
    expect(err.status).toBe(500);
    expect(err.serverMessage).toBe('Datenbank kaputt');
    expect(err.message).toContain('HTTP 500');
    expect(err.message).toContain('Datenbank kaputt');
  });
});

describe('putBoardPhotoMask', () => {
  it('PUTet die Maske als JSON im Wire-Vertrag {points}', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const mask = { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] };
    await putBoardPhotoMask('b/1', mask);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/board-photo-assets/b%2F1/mask');
    expect(init.method).toBe('PUT');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(mask);
  });
});

describe('putBoardPhotoOverlay', () => {
  it('sendet Bild und Kalibrierung als Multipart ohne eigenen content-type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const image = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
    const cal = calibration();
    await putBoardPhotoOverlay('b', 'bottom', image, cal);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/board-photo-assets/b/overlays/bottom');
    expect(init.method).toBe('PUT');
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    // Node normalisiert Blob → File, daher Größe und Typ statt Identität prüfen.
    expect(init.body.get('image').size).toBe(image.size);
    expect(init.body.get('image').type).toBe(image.type);
    expect(init.body.get('calibration')).toBe(JSON.stringify(cal));
  });
});

describe('putBoardPhotoCalibration', () => {
  it('PUTet die Kalibrierung als JSON im Wire-Vertrag {version, points}', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const cal = calibration();
    cal.points.push({ id: 2, board: { x: 0.9, y: 0.9 }, photo: { x: 0.8, y: 0.8 } });
    cal.points.push({ id: 3, board: { x: 0.5, y: 0.1 }, photo: { x: 0.4, y: 0.2 } });
    cal.points.push({ id: 4, board: { x: 0.1, y: 0.5 }, photo: { x: 0.2, y: 0.4 } });
    await putBoardPhotoCalibration('b', 'bottom', cal);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/board-photo-assets/b/overlays/bottom/calibration');
    expect(init.method).toBe('PUT');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(cal);
    // Eingefrorener P0-Vertrag: kein side, kein homography im gesendeten JSON.
    expect(init.body).not.toContain('"side"');
    expect(init.body).not.toContain('"homography"');
    expect(init.body).toContain('"version":1');
  });
});

describe('deleteBoardPhotoOverlay', () => {
  it('DELETEt das Overlay der Seite', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteBoardPhotoOverlay('b', 'top');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/board-photo-assets/b/overlays/top');
    expect(init.method).toBe('DELETE');
  });
});

describe('buildOverlayUrl', () => {
  it('baut URLs für source und render mit encodierten Segmenten', () => {
    expect(buildOverlayUrl('a b/c', 'top', 'source'))
      .toBe('/api/board-photo-assets/a%20b%2Fc/overlays/top/source');
    expect(buildOverlayUrl('x', 'bottom', 'render'))
      .toBe('/api/board-photo-assets/x/overlays/bottom/render');
  });
});

describe('Fehlerbehandlung', () => {
  it('wickelt Netzwerkfehler in PhotoOverlayApiError mit status 0 ein', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const err = await getBoardPhotoAsset('x').catch((e) => e);
    expect(err).toBeInstanceOf(PhotoOverlayApiError);
    expect(err.status).toBe(0);
    expect(err.serverMessage).toBeNull();
    expect(err.message).toContain('Netzwerkfehler');
  });

  it('nutzt den Klartext-Körper als Meldung, wenn kein JSON vorliegt', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, 'sync already in progress', 'text/plain'));
    vi.stubGlobal('fetch', fetchMock);

    const err = await putBoardPhotoMask('x', { points: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(PhotoOverlayApiError);
    expect(err.status).toBe(409);
    expect(err.serverMessage).toBe('sync already in progress');
  });
});
