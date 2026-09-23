import { describe, expect, it, vi } from 'vitest';
import { ImageSource, Mesh, MeshGeometry, Texture } from 'pixi.js';
import {
  buildOverlayMeshData,
  createOverlayMesh,
  OVERLAY_GRID_CELLS,
  OVERLAY_GRID_VERTICES,
} from './photo-overlay-mesh';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const AFFINE = [2, 0, 5, 0, 3, -7, 0, 0, 1];
const PROJECTIVE = [1, 0, 0, 0, 1, 0, 0.0004, -0.0002, 1];
const BOUNDS = { minX: 0, minY: 0, maxX: 1000, maxY: 500 };

describe('buildOverlayMeshData', () => {
  it('erzeugt 33×33 Vertices und 32×32 deterministische Dreiecke', () => {
    const mesh = buildOverlayMeshData(IDENTITY, BOUNDS);

    expect(mesh.positions).toHaveLength(OVERLAY_GRID_VERTICES * OVERLAY_GRID_VERTICES * 2);
    expect(mesh.uvs).toHaveLength(mesh.positions.length);
    expect(mesh.indices).toHaveLength(OVERLAY_GRID_CELLS * OVERLAY_GRID_CELLS * 6);
    for (const index of mesh.indices) {
      expect(index).toBeLessThan(OVERLAY_GRID_VERTICES * OVERLAY_GRID_VERTICES);
    }
    // Jede Zelle besteht aus denselben zwei Dreiecken (a, b, d) und (a, d, c).
    expect([...mesh.indices.slice(0, 12)]).toEqual([0, 1, 34, 0, 34, 33, 1, 2, 35, 1, 35, 34]);
  });

  it('deckt die Board-Bounds vollständig ab', () => {
    const mesh = buildOverlayMeshData(IDENTITY, BOUNDS);
    const last = (mesh.positions.length - 2) / 2;

    expect(mesh.positions[0]).toBe(BOUNDS.minX);
    expect(mesh.positions[1]).toBe(BOUNDS.minY);
    expect(mesh.positions[last * 2]).toBe(BOUNDS.maxX);
    expect(mesh.positions[last * 2 + 1]).toBe(BOUNDS.maxY);
    expect(Math.min(...mesh.positions)).toBe(BOUNDS.minX);
    expect(Math.max(...mesh.positions)).toBe(BOUNDS.maxX);
    // Zeile 0 liegt auf minY, Spalte 0 auf minX.
    expect(mesh.positions[1 * 2 + 1]).toBe(BOUNDS.minY);
    expect(mesh.positions[OVERLAY_GRID_VERTICES * 2]).toBe(BOUNDS.minX);
  });

  it('bildet bei Identität die Boardposition 1:1 als UV ab', () => {
    const mesh = buildOverlayMeshData(IDENTITY, BOUNDS);
    expect([...mesh.uvs]).toEqual([...mesh.positions]);
  });

  it('erzeugt für eine bekannte affine Abbildung exakte UVs', () => {
    const mesh = buildOverlayMeshData(AFFINE, BOUNDS);
    const uvAt = (row: number, column: number) => {
      const vertex = (row * OVERLAY_GRID_VERTICES + column) * 2;
      return { u: mesh.uvs[vertex], v: mesh.uvs[vertex + 1] };
    };

    expect(uvAt(0, 0)).toEqual({ u: 5, v: -7 });
    expect(uvAt(16, 8)).toEqual({ u: 2 * 250 + 5, v: 3 * 250 - 7 });
    expect(uvAt(32, 32)).toEqual({ u: 2 * 1000 + 5, v: 3 * 500 - 7 });
  });

  it('erzeugt für eine bekannte projektive Abbildung exakte UVs', () => {
    const mesh = buildOverlayMeshData(PROJECTIVE, BOUNDS);
    const uvAt = (x: number, y: number) => {
      const column = (x - BOUNDS.minX) / ((BOUNDS.maxX - BOUNDS.minX) / OVERLAY_GRID_CELLS);
      const row = (y - BOUNDS.minY) / ((BOUNDS.maxY - BOUNDS.minY) / OVERLAY_GRID_CELLS);
      const vertex = (Math.round(row) * OVERLAY_GRID_VERTICES + Math.round(column)) * 2;
      return { u: mesh.uvs[vertex], v: mesh.uvs[vertex + 1] };
    };

    for (const [x, y] of [[0, 0], [500, 250], [1000, 500]]) {
      const denominator = 1 + 0.0004 * x - 0.0002 * y;
      // UVs liegen in einem Float32Array; der erwartete double-Wert muss
      // deshalb auf float32 gerundet verglichen werden.
      expect(uvAt(x, y).u).toBe(Math.fround(x / denominator));
      expect(uvAt(x, y).v).toBe(Math.fround(y / denominator));
    }
  });

  it('liefert verständliche Fehler für ungültige Matrizen', () => {
    expect(() => buildOverlayMeshData([1, 0, 0, 0, 1, 0, 0, 0], BOUNDS)).toThrow(TypeError);
    expect(() => buildOverlayMeshData([1, 0, 0, 0, NaN, 0, 0, 0, 1], BOUNDS)).toThrow(TypeError);
    expect(() => buildOverlayMeshData([1, 0, 0, 0, NaN, 0, 0, 0, 1], BOUNDS))
      .toThrow('Die Homografiematrix muss aus 9 endlichen Zahlen bestehen.');
  });

  it('liefert verständliche Fehler für Projektionssingularitäten', () => {
    // h31 = -0.001 hebt den Nenner beim Vertex x = 1000 exakt auf 0.
    const singular = [1, 0, 0, 0, 1, 0, -0.001, 0, 1];
    expect(() => buildOverlayMeshData(singular, BOUNDS)).toThrow(RangeError);
    expect(() => buildOverlayMeshData(singular, BOUNDS))
      .toThrow('nicht projizieren');
  });

  it('lehnt degenerierte Bounds ab', () => {
    expect(() => buildOverlayMeshData(IDENTITY, { minX: 10, minY: 0, maxX: 10, maxY: 500 }))
      .toThrow(RangeError);
    expect(() => buildOverlayMeshData(IDENTITY, { minX: NaN, minY: 0, maxX: 10, maxY: 500 }))
      .toThrow(RangeError);
  });
});

describe('createOverlayMesh', () => {
  it('baut Pixi-Texture, -Geometrie und -Mesh aus einem ImageBitmap', () => {
    const bitmap = { width: 8, height: 4 } as unknown as ImageBitmap;
    const data = buildOverlayMeshData(IDENTITY, BOUNDS);
    const resources = createOverlayMesh(bitmap, data);

    expect(resources.mesh).toBeInstanceOf(Mesh);
    expect(resources.texture).toBeInstanceOf(Texture);
    expect(resources.geometry).toBeInstanceOf(MeshGeometry);
    expect(resources.texture.source).toBeInstanceOf(ImageSource);
    expect(resources.texture.source.width).toBe(8);
    expect(resources.texture.source.height).toBe(4);
    expect(resources.mesh.geometry).toBe(resources.geometry);
    expect(resources.mesh.texture).toBe(resources.texture);
    expect(resources.geometry.positions).toBe(data.positions);
    expect(resources.geometry.positions.length / 2).toBeGreaterThan(100);

    resources.dispose();
  });

  it('dispose zerstört alle Ressourcen genau einmal und ist idempotent', () => {
    const bitmap = { width: 8, height: 4 } as unknown as ImageBitmap;
    const resources = createOverlayMesh(bitmap, buildOverlayMeshData(IDENTITY, BOUNDS));
    const source = resources.texture.source;
    const buffers = resources.geometry.buffers;
    const meshDestroy = vi.spyOn(resources.mesh, 'destroy');
    const geometryDestroy = vi.spyOn(resources.geometry, 'destroy');

    resources.dispose();
    resources.dispose();

    expect(meshDestroy).toHaveBeenCalledTimes(1);
    expect(geometryDestroy).toHaveBeenCalledTimes(1);
    expect(resources.texture.destroyed).toBe(true);
    expect(source.destroyed).toBe(true);
    expect(buffers.every((buffer) => buffer.destroyed)).toBe(true);
  });
});
