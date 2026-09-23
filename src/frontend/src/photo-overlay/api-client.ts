/**
 * Typisierter API-Client für PCB-Foto-Overlays.
 *
 * Kapselt alle Aufrufe gegen /api/board-photo-assets/{boardKey}:
 * Asset-Zustand laden, Maske speichern, Overlay-Bild samt Kalibrierung
 * hochladen, Kalibrierung nachziehen und Overlays löschen. Alle Methoden
 * werfen bei Fehlern eine PhotoOverlayApiError mit HTTP-Status und — falls
 * der Server eine schickt — verständlicher Meldung.
 */

import type { ManualBoardMask, OverlayAssetMetadata, OverlaySide, PhotoCalibration } from './types';

/** Bildvariante unter /overlays/{side}/{variant}. */
export type OverlayVariant = 'source' | 'render';

/** Ein gespeichertes Overlay auf einer Boardseite: Bild-Metadaten plus
 *  Kalibrierung (null, solange noch nicht kalibriert). */
export interface StoredOverlay {
  metadata: OverlayAssetMetadata;
  calibration: PhotoCalibration | null;
}

/** Gesamter Foto-Asset-Zustand für einen boardKey. */
export interface BoardPhotoAssetState {
  mask: ManualBoardMask | null;
  overlays: Partial<Record<OverlaySide, StoredOverlay>>;
}

/** Fehler eines API-Aufrufs. status = 0 bedeutet: kein HTTP-Status
 *  erhalten (z. B. Netzwerkfehler oder Timeout). */
export class PhotoOverlayApiError extends Error {
  readonly status: number;
  readonly serverMessage: string | null;

  constructor(status: number, serverMessage: string | null, message: string) {
    super(message);
    this.name = 'PhotoOverlayApiError';
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

/** Leerer Zustand für ein unbekanntes Asset. */
function emptyState(): BoardPhotoAssetState {
  return { mask: null, overlays: {} };
}

function assetUrl(boardKey: string): string {
  return `/api/board-photo-assets/${encodeURIComponent(boardKey)}`;
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new PhotoOverlayApiError(0, null, `Netzwerkfehler bei ${url}: ${reason}`);
  }
  return res;
}

/** Liest die Servermeldung aus dem Fehlerkörper (JSON `{"error": …}` /
 *  `{"message": …}` oder Klartext) und wirft eine PhotoOverlayApiError. */
async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  let serverMessage: string | null = null;
  try {
    const body = (await res.text()).trim();
    if (body) {
      try {
        const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
        if (typeof parsed.error === 'string') serverMessage = parsed.error;
        else if (typeof parsed.message === 'string') serverMessage = parsed.message;
      } catch { /* kein JSON — Klartext als Meldung nehmen */ }
      if (serverMessage === null && body) serverMessage = body;
    }
  } catch { /* Körper nicht lesbar — Meldung bleibt null */ }
  const detail = serverMessage ? `: ${serverMessage}` : '';
  throw new PhotoOverlayApiError(res.status, serverMessage, `Anfrage fehlgeschlagen (HTTP ${res.status})${detail}`);
}

/** Lädt den Asset-Zustand. Ein unbekanntes Asset (404) ergibt den
 *  leeren Zustand statt eines Fehlers. */
export async function getBoardPhotoAsset(boardKey: string): Promise<BoardPhotoAssetState> {
  const res = await request(assetUrl(boardKey));
  if (res.status === 404) return emptyState();
  await ensureOk(res);
  try {
    return await res.json() as BoardPhotoAssetState;
  } catch {
    throw new PhotoOverlayApiError(res.status, null, `Antwort war kein gültiges Asset-JSON (HTTP ${res.status})`);
  }
}

/** Speichert die manuell gezeichnete Board-Maske. */
export async function putBoardPhotoMask(boardKey: string, mask: ManualBoardMask): Promise<void> {
  const res = await request(`${assetUrl(boardKey)}/mask`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mask),
  });
  await ensureOk(res);
}

/** Lädt das Overlay-Bild für eine Boardseite hoch, zusammen mit der
 *  PhotoCalibration als zweitem Multipart-Feld. */
export async function putBoardPhotoOverlay(
  boardKey: string,
  side: OverlaySide,
  image: Blob,
  calibration: PhotoCalibration,
): Promise<void> {
  const form = new FormData();
  form.append('image', image);
  form.append('calibration', JSON.stringify(calibration));
  const res = await request(`${assetUrl(boardKey)}/overlays/${encodeURIComponent(side)}`, {
    method: 'PUT',
    body: form,
  });
  await ensureOk(res);
}

/** Aktualisiert nur die Kalibrierung eines bestehenden Overlays. */
export async function putBoardPhotoCalibration(
  boardKey: string,
  side: OverlaySide,
  calibration: PhotoCalibration,
): Promise<void> {
  const res = await request(`${assetUrl(boardKey)}/overlays/${encodeURIComponent(side)}/calibration`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(calibration),
  });
  await ensureOk(res);
}

/** Löscht das Overlay einer Boardseite (Bild und Kalibrierung). */
export async function deleteBoardPhotoOverlay(boardKey: string, side: OverlaySide): Promise<void> {
  const res = await request(`${assetUrl(boardKey)}/overlays/${encodeURIComponent(side)}`, {
    method: 'DELETE',
  });
  await ensureOk(res);
}

/** Baut die URL für das Overlay-Bild einer Boardseite, wie sie z. B. in
 *  <img src> oder der Renderer-Textur verwendet wird. */
export function buildOverlayUrl(boardKey: string, side: OverlaySide, variant: OverlayVariant): string {
  return `${assetUrl(boardKey)}/overlays/${encodeURIComponent(side)}/${encodeURIComponent(variant)}`;
}
