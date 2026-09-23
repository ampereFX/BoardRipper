import { ImageSource, Mesh, MeshGeometry, Texture } from 'pixi.js';
import { applyHomography } from '../photo-overlay/homography';

/** Board-Bounds im lokalen Board-Koordinatenraum (mils). */
export interface BoardBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Referenzraster: 32×32 Zellen → 33×33 Vertices. */
export const OVERLAY_GRID_CELLS = 32;
export const OVERLAY_GRID_VERTICES = OVERLAY_GRID_CELLS + 1;

const VERTEX_COUNT = OVERLAY_GRID_VERTICES * OVERLAY_GRID_VERTICES;

/** Reine Mesh-Geometrie ohne Pixi-Ressourcen: Positionen im lokalen Board-
 *  Koordinatenraum, UVs in Foto-Koordinaten (gleiche Skala wie die
 *  Board→Foto-Homografie), Dreiecksindizes. */
export interface OverlayMeshData {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** Erzeugt das 32×32-Zellen-Raster über die Board-Bounds. Die UVs je Vertex
 *  stammen aus der Board→Foto-Homografie. Die Dreiecke interpolieren UV
 *  affin, was die projektive Abbildung stückweise approximiert — ein eigener
 *  Shader ist dafür nicht nötig. */
export function buildOverlayMeshData(matrix: number[], bounds: BoardBounds): OverlayMeshData {
  if (matrix.length !== 9 || matrix.some((value) => !Number.isFinite(value))) {
    throw new TypeError('Die Homografiematrix muss aus 9 endlichen Zahlen bestehen.');
  }
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
    || bounds.minX >= bounds.maxX || bounds.minY >= bounds.maxY) {
    throw new RangeError('Die Board-Bounds müssen endlich sein und eine positive Fläche haben.');
  }

  const positions = new Float32Array(VERTEX_COUNT * 2);
  const uvs = new Float32Array(VERTEX_COUNT * 2);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;

  for (let row = 0; row < OVERLAY_GRID_VERTICES; row++) {
    const y = bounds.minY + (height * row) / OVERLAY_GRID_CELLS;
    for (let column = 0; column < OVERLAY_GRID_VERTICES; column++) {
      const x = bounds.minX + (width * column) / OVERLAY_GRID_CELLS;
      const vertex = row * OVERLAY_GRID_VERTICES + column;
      positions[vertex * 2] = x;
      positions[vertex * 2 + 1] = y;

      let uv: { x: number; y: number };
      try {
        uv = applyHomography(matrix, { x, y });
      } catch {
        throw new RangeError(
          'Die Homografie kann den Boardpunkt (' + x + ', ' + y
            + ') (Vertex ' + vertex + ') nicht projizieren.',
        );
      }
      uvs[vertex * 2] = uv.x;
      uvs[vertex * 2 + 1] = uv.y;
    }
  }

  const indices = new Uint32Array(OVERLAY_GRID_CELLS * OVERLAY_GRID_CELLS * 6);
  let cursor = 0;
  for (let row = 0; row < OVERLAY_GRID_CELLS; row++) {
    for (let column = 0; column < OVERLAY_GRID_CELLS; column++) {
      const a = row * OVERLAY_GRID_VERTICES + column;
      const b = a + 1;
      const c = a + OVERLAY_GRID_VERTICES;
      const d = c + 1;
      indices[cursor++] = a;
      indices[cursor++] = b;
      indices[cursor++] = d;
      indices[cursor++] = a;
      indices[cursor++] = d;
      indices[cursor++] = c;
    }
  }

  return { positions, uvs, indices };
}

/** Pixi-Ressourcen eines Foto-Overlay-Mesh. dispose() ist idempotent und
 *  zerstört Mesh, Texture, TextureSource und Geometry genau einmal. */
export interface OverlayMeshResources {
  mesh: Mesh;
  texture: Texture;
  geometry: MeshGeometry;
  dispose(): void;
}

/** Dünne Factory: baut aus einem dekodierten ImageBitmap die Pixi-Textur und
 *  aus den Mesh-Daten die Pixi-Geometrie. Läuft auch headless, weil Pixi v8
 *  Texture/Geometry ohne Renderer instanziierbar ist. */
export function createOverlayMesh(bitmap: ImageBitmap, data: OverlayMeshData): OverlayMeshResources {
  const source = new ImageSource({ resource: bitmap });
  const texture = new Texture({ source });
  const geometry = new MeshGeometry({
    positions: data.positions,
    uvs: data.uvs,
    indices: data.indices,
  });
  const mesh = new Mesh({ geometry, texture });

  let disposed = false;
  return {
    mesh,
    texture,
    geometry,
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.destroy({ texture: true, textureSource: true });
      geometry.destroy(true);
    },
  };
}
