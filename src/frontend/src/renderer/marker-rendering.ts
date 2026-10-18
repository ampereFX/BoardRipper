export interface MarkerScreenPoint {
  id: string;
  x: number;
  y: number;
}

export interface MarkerCluster {
  x: number;
  y: number;
  markerIds: string[];
}

/** Converts a marker's raw file side to the physical side action in files
 *  whose parser primary side is the bottom layer. */
export function physicalSideForMarker(side: 'top' | 'bottom', primarySide: 'top' | 'bottom' | undefined): 'top' | 'bottom' {
  return primarySide === 'bottom' ? (side === 'top' ? 'bottom' : 'top') : side;
}

/** Groups markers that would overlap at the current zoom, using screen pixels
 *  so the same cluster spacing works at every board zoom level. */
export function clusterMarkerPoints(points: MarkerScreenPoint[], distancePx = 22): MarkerCluster[] {
  const clusters: MarkerCluster[] = [];
  const remaining = new Set(points.map((_, index) => index));
  const maxDistance2 = distancePx * distancePx;

  while (remaining.size > 0) {
    const anchorIndex = remaining.values().next().value as number;
    const anchor = points[anchorIndex];
    const members: number[] = [];
    for (const index of remaining) {
      const point = points[index];
      if ((point.x - anchor.x) ** 2 + (point.y - anchor.y) ** 2 <= maxDistance2) {
        members.push(index);
      }
    }
    members.forEach(index => remaining.delete(index));
    clusters.push({
      x: members.reduce((sum, index) => sum + points[index].x, 0) / members.length,
      y: members.reduce((sum, index) => sum + points[index].y, 0) / members.length,
      markerIds: members.map(index => points[index].id),
    });
  }

  return clusters;
}

/** Returns the nearest marker inside a screen-space radius. */
export function markerAtScreenPoint(
  points: MarkerScreenPoint[],
  x: number,
  y: number,
  radiusPx = 12,
): string | null {
  const radius2 = radiusPx * radiusPx;
  let nearest: string | null = null;
  let nearestDistance2 = radius2;
  for (const point of points) {
    const distance2 = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (distance2 <= nearestDistance2) {
      nearest = point.id;
      nearestDistance2 = distance2;
    }
  }
  return nearest;
}
