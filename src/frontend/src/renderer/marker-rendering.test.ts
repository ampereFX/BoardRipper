import { describe, expect, it } from 'vitest';
import { clusterMarkerPoints, markerAtScreenPoint, physicalSideForMarker } from './marker-rendering';

describe('marker screen behavior', () => {
  it('clusters nearby markers in screen pixels', () => {
    expect(clusterMarkerPoints([
      { id: 'a', x: 10, y: 10 },
      { id: 'b', x: 20, y: 10 },
      { id: 'c', x: 70, y: 10 },
    ])).toEqual([
      { x: 15, y: 10, markerIds: ['a', 'b'] },
      { x: 70, y: 10, markerIds: ['c'] },
    ]);
  });

  it('chooses the nearest marker within a screen-space radius', () => {
    const points = [
      { id: 'a', x: 10, y: 10 },
      { id: 'b', x: 19, y: 10 },
    ];
    expect(markerAtScreenPoint(points, 18, 10)).toBe('b');
    expect(markerAtScreenPoint(points, 40, 10)).toBeNull();
  });

  it('maps raw marker sides through a bottom-primary board', () => {
    expect(physicalSideForMarker('top', 'bottom')).toBe('bottom');
    expect(physicalSideForMarker('bottom', 'bottom')).toBe('top');
    expect(physicalSideForMarker('top', 'top')).toBe('top');
  });
});
