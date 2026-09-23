import { splitOutlineContours } from '../parsers/types';
import type { Point } from '../parsers/types';
import { validateManualBoardMask } from '../photo-overlay/mask-validation';
import type { ManualBoardMask, NormalizedPoint } from '../photo-overlay/types';

/** Woher das Maskenpolygon stammt: 'outline' = größte geschlossene Kontur der
 *  Board-Outline (Koordinaten im Board-Koordinatenraum), 'manual' = manuell
 *  gezeichnete Maske (normalisierte lokale Board-Koordinaten, ManualBoardMask-
 *  Vertrag über das Feld points). */
export type BoardMaskSource = 'outline' | 'manual';

export interface BoardMaskPolygon {
  polygon: NormalizedPoint[];
  source: BoardMaskSource;
}

export interface BoardBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Überführt manuelle, lokal normalisierte Punkte direkt in den rohen
 *  Board-Koordinatenraum. Die bestehende Outline liegt bereits dort. */
export function boardMaskToRawCoordinates(
  mask: BoardMaskPolygon | null,
  bounds: BoardBounds,
): Point[] {
  if (!mask) return [];
  if (mask.source === 'outline') return mask.polygon.map((point) => ({ x: point.x, y: point.y }));

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  return mask.polygon.map((point) => ({
    x: bounds.minX + point.x * width,
    y: bounds.minY + point.y * height,
  }));
}

/** Fläche über die Shoelace-Formel; Translation auf den ersten Punkt
 *  vermeidet Auslöschung bei großen Koordinaten. */
function shoelaceArea(points: NormalizedPoint[]): number {
  const origin = points[0];
  let doubled = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    doubled += (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  }
  return doubled / 2;
}

/** Bereitet eine Kontur als implizit geschlossenes Polygon auf: entfernt
 *  aufeinanderfolgende Duplikate und einen redundanten Schlussequivalentpunkt. */
function cleanClosedPolygon(points: Point[]): NormalizedPoint[] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const epsilon = 1e-6 * Math.max(maxX - minX, maxY - minY, 1);

  const cleaned: NormalizedPoint[] = [];
  for (const point of points) {
    const previous = cleaned[cleaned.length - 1];
    if (previous
      && Math.abs(previous.x - point.x) <= epsilon
      && Math.abs(previous.y - point.y) <= epsilon) {
      continue;
    }
    cleaned.push({ x: point.x, y: point.y });
  }
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (cleaned.length >= 2
    && Math.abs(first.x - last.x) <= epsilon
    && Math.abs(first.y - last.y) <= epsilon) {
    cleaned.pop();
  }
  return cleaned;
}

/** Löst die V1-Board-Maske für ein Foto-Overlay: Von der bestehenden
 *  geschlossenen Board-Outline (NaN-getrennte Konturen) wird die äußere
 *  Kontur — die mit der größten Fläche — als Polygon gewählt. Liefert die
 *  Outline keine nutzbare Kontur, wird ersatzweise die manuelle Maske
 *  verwendet (V1 ohne Löcher). Ist auch diese ungültig, gibt es einen
 *  verständlichen Fehler; ohne Maske wird null geliefert. */
export function resolveBoardMaskPolygon(
  outline: Point[],
  manualMask: ManualBoardMask | null,
): BoardMaskPolygon | null {
  let best: NormalizedPoint[] | null = null;
  let bestArea = 0;
  for (const contour of splitOutlineContours(outline)) {
    if (contour.length < 3) continue;
    const polygon = cleanClosedPolygon(contour);
    if (polygon.length < 3) continue;
    const area = Math.abs(shoelaceArea(polygon));
    if (area > bestArea) {
      bestArea = area;
      best = polygon;
    }
  }
  if (best) return { polygon: best, source: 'outline' };

  if (manualMask) {
    const validation = validateManualBoardMask(manualMask);
    if (validation.valid) return { polygon: manualMask.points, source: 'manual' };
    throw new Error('Die manuelle Board-Maske ist ungültig: ' + validation.reason);
  }
  return null;
}
