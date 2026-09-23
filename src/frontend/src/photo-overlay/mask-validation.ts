import type { ManualBoardMask } from './types';

export interface MaskValidationResult {
  valid: boolean;
  reason: string | null;
}

interface PointLike {
  x: number;
  y: number;
}

function cross(origin: PointLike, a: PointLike, b: PointLike): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function pointsEqual(a: PointLike, b: PointLike, epsilon: number): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

function onSegment(point: PointLike, start: PointLike, end: PointLike, epsilon: number): boolean {
  return Math.abs(cross(start, end, point)) <= epsilon
    && point.x >= Math.min(start.x, end.x) - epsilon
    && point.x <= Math.max(start.x, end.x) + epsilon
    && point.y >= Math.min(start.y, end.y) - epsilon
    && point.y <= Math.max(start.y, end.y) + epsilon;
}

function segmentsIntersect(
  aStart: PointLike,
  aEnd: PointLike,
  bStart: PointLike,
  bEnd: PointLike,
  epsilon: number,
): boolean {
  const a = cross(aStart, aEnd, bStart);
  const b = cross(aStart, aEnd, bEnd);
  const c = cross(bStart, bEnd, aStart);
  const d = cross(bStart, bEnd, aEnd);

  if (((a > epsilon && b < -epsilon) || (a < -epsilon && b > epsilon))
    && ((c > epsilon && d < -epsilon) || (c < -epsilon && d > epsilon))) {
    return true;
  }
  return (Math.abs(a) <= epsilon && onSegment(bStart, aStart, aEnd, epsilon))
    || (Math.abs(b) <= epsilon && onSegment(bEnd, aStart, aEnd, epsilon))
    || (Math.abs(c) <= epsilon && onSegment(aStart, bStart, bEnd, epsilon))
    || (Math.abs(d) <= epsilon && onSegment(aEnd, bStart, bEnd, epsilon));
}

/** Validiert genau eine implizit geschlossene Außenkontur ohne Löcher. */
export function validateManualBoardMask(mask: ManualBoardMask): MaskValidationResult {
  const points = mask.points;
  if (points.length < 3) {
    return { valid: false, reason: 'Die Außenkontur braucht mindestens 3 Punkte.' };
  }
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return { valid: false, reason: 'Alle Punkte müssen endliche Koordinaten haben.' };
  }

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const scale = Math.max(maxX - minX, maxY - minY, 1);
  const coordinateEpsilon = 1e-12 * scale;
  const areaEpsilon = 1e-12 * scale * scale;

  for (let index = 0; index < points.length; index++) {
    const previous = (index - 1 + points.length) % points.length;
    const next = (index + 1) % points.length;
    if (pointsEqual(points[index], points[next], coordinateEpsilon)) {
      return { valid: false, reason: 'Die Außenkontur enthält eine Kante ohne Länge.' };
    }
    const turn = cross(points[previous], points[index], points[next]);
    const backwardDot = (points[previous].x - points[index].x) * (points[next].x - points[index].x)
      + (points[previous].y - points[index].y) * (points[next].y - points[index].y);
    if (Math.abs(turn) <= areaEpsilon && backwardDot > coordinateEpsilon * coordinateEpsilon) {
      return { valid: false, reason: 'Die Außenkontur enthält kollinear überlappende Kanten.' };
    }
  }

  // Nicht benachbarte Kanten dürfen sich weder kreuzen, berühren noch
  // kollinear überlappen. Benachbarte Kanten teilen ihren Endpunkt absichtlich.
  for (let first = 0; first < points.length; first++) {
    const firstEnd = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second++) {
      const secondEnd = (second + 1) % points.length;
      const adjacent = first === second
        || firstEnd === second
        || secondEnd === first;
      if (adjacent) continue;
      if (segmentsIntersect(
        points[first],
        points[firstEnd],
        points[second],
        points[secondEnd],
        areaEpsilon,
      )) {
        return { valid: false, reason: 'Die Außenkontur überschneidet oder berührt sich selbst.' };
      }
    }
  }

  // Translation vor der Shoelace-Summe vermeidet Auslöschung bei großen
  // absoluten Koordinaten.
  const origin = points[0];
  let doubledArea = 0;
  for (let index = 1; index < points.length - 1; index++) {
    doubledArea += cross(origin, points[index], points[index + 1]);
  }
  if (Math.abs(doubledArea) / 2 <= areaEpsilon) {
    return { valid: false, reason: 'Die Außenkontur hat degenerierte Fläche.' };
  }

  return { valid: true, reason: null };
}
