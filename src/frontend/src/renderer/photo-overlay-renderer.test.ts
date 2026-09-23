/* eslint-disable @typescript-eslint/no-explicit-any -- private renderer probes need runtime seams */
import { describe, expect, it, vi } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { BoardRenderer } from './BoardRenderer';
import { buildBoardScene, type BoardSceneGraph } from './board-scene';
import { DEFAULTS } from '../store/render-settings';
import { boardStore } from '../store/board-store';
import { photoOverlayStore, type OverlayBoardState } from '../photo-overlay/overlay-store';
import { boardLifecycleController } from '../photo-overlay/board-lifecycle-controller';
import type { BoardData } from '../parsers/types';
import { buildOverlayMeshData, createOverlayMesh } from './photo-overlay-mesh';

vi.mock('../photo-overlay/view-preferences', () => ({
  loadOverlayDisplayPreferences: vi.fn(async () => ({ visible: true, opacity: 0.5 })),
}));

// BoardRenderer imports the PDF store for unrelated interaction paths. Keep
// this renderer-only test headless and avoid loading pdfjs' DOM canvas code.
vi.mock('../store/pdf-store', () => ({ pdfStore: {} }));
vi.mock('../store/dockview-api', () => ({ ensurePdfPanel: vi.fn() }));
vi.mock('../panels/board-viewer-bridge', () => ({ openBoardSidebarTab: vi.fn() }));
vi.mock('../hooks/usePdfStore', () => ({ usePdfStore: vi.fn() }));

const BOARD = {
  format: 'TEST',
  flipY: false,
  outline: [
    { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 600 }, { x: 0, y: 600 }, { x: 0, y: 0 },
  ],
  bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 600 },
  parts: [
    {
      name: 'U1', side: 'top', type: 'smd', origin: { x: 200, y: 200 },
      pins: [{ name: '1', number: '1', position: { x: 200, y: 200 }, radius: 20, side: 'top', net: 'N1' }],
      bounds: { minX: 180, minY: 180, maxX: 220, maxY: 220 },
    },
    {
      name: 'U2', side: 'bottom', type: 'smd', origin: { x: 700, y: 400 },
      pins: [{ name: '1', number: '1', position: { x: 700, y: 400 }, radius: 20, side: 'bottom', net: 'N2' }],
      bounds: { minX: 680, minY: 380, maxX: 720, maxY: 420 },
    },
  ],
  nails: [],
  nets: new Map(),
  surfaces: [{ polygon: [{ x: 50, y: 50 }, { x: 950, y: 50 }, { x: 950, y: 550 }, { x: 50, y: 550 }] }],
  traces: [{ start: { x: 100, y: 100 }, end: { x: 900, y: 100 }, width: 8, net: 'N1' }],
  silkscreen: [
    { side: 'top', points: [{ x: 150, y: 150 }, { x: 250, y: 150 }] },
    { side: 'bottom', points: [{ x: 650, y: 350 }, { x: 750, y: 350 }] },
  ],
  pads: [
    { side: 'top', attached: true, net: 'N1', bounds: { minX: 180, minY: 190, maxX: 220, maxY: 210 } },
    { side: 'bottom', attached: true, net: 'N2', bounds: { minX: 680, minY: 390, maxX: 720, maxY: 410 } },
  ],
} as unknown as BoardData;

const settings = {
  ...DEFAULTS,
  showSurfaces: true,
  showTraces: true,
  showSilkscreen: true,
  showPads: true,
  showComponents: true,
};

type TestScene = BoardSceneGraph & {
  butterflyRoot: Container | null;
  butterflyOutline: Graphics | null;
};

function scene(): TestScene {
  return { ...buildBoardScene(BOARD, settings), butterflyRoot: null, butterflyOutline: null };
}

function setActiveTab(values: Record<string, unknown>): () => void {
  const store = boardStore as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(store, 'activeTab');
  Object.defineProperty(store, 'activeTab', { configurable: true, value: values });
  return () => {
    if (previous) Object.defineProperty(store, 'activeTab', previous);
    else delete store.activeTab;
  };
}

function rendererWithoutConstructor(): Record<string, any> {
  return Object.create(BoardRenderer.prototype) as Record<string, any>;
}

function resourceBitmap(): ImageBitmap {
  return { width: 16, height: 16, close: vi.fn() } as unknown as ImageBitmap;
}

function validCalibration() {
  return {
    version: 1 as const,
    points: [
      { id: 1, board: { x: 0, y: 0 }, photo: { x: 0, y: 0 } },
      { id: 2, board: { x: 1, y: 0 }, photo: { x: 1, y: 0 } },
      { id: 3, board: { x: 1, y: 1 }, photo: { x: 1, y: 1 } },
      { id: 4, board: { x: 0, y: 1 }, photo: { x: 0, y: 1 } },
    ],
  };
}

function overlayState(bitmap: ImageBitmap): OverlayBoardState {
  return {
    mask: null,
    sides: {
      top: {
        status: 'ready', metadata: { id: 'top-1', mimeType: 'image/png', widthPx: 16, heightPx: 16 },
        calibration: validCalibration(), renderImage: bitmap, renderImageStatus: 'ready', error: null,
      },
      bottom: {
        status: 'ready', metadata: null, calibration: null,
        renderImage: null, renderImageStatus: 'idle', error: null,
      },
    },
  };
}

function standaloneRuntime(renderer: Record<string, any>, bitmap: ImageBitmap): Record<string, any> {
  const mask = (BoardRenderer.prototype as any).createOverlayMask.call(renderer, [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 },
  ]) as Graphics;
  const resources = createOverlayMesh(bitmap, buildOverlayMeshData(
    [1, 0, 0, 0, 1, 0, 0, 0, 1],
    { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  ));
  resources.mesh.mask = mask;
  return {
    side: 'top', boardKey: 'board-key', signature: 'signature', image: bitmap,
    resources, mask, visible: true, opacity: 0.5,
  };
}

function expectFreedOnce(runtime: Record<string, any>, bitmap: ImageBitmap): void {
  expect(runtime.resources.mesh.destroy).toHaveBeenCalledTimes(1);
  expect(runtime.resources.texture.destroy).toHaveBeenCalledTimes(1);
  expect(runtime.resources.geometry.destroy).toHaveBeenCalledTimes(1);
  expect(runtime.mask.destroy).toHaveBeenCalledTimes(1);
  expect(bitmap.close).not.toHaveBeenCalled();
}

describe('Photo-Overlay-Rendererintegration', () => {
  it('ordnet Boardfüllung, Foto, Kupfer, Silkscreen und Komponenten stabil', () => {
    const built = scene();
    const root = built.root.children;
    const expected = [
      built.outlineGfx,
      built.photoOverlayTop,
      built.photoOverlayBottom,
      built.surfacesLayer,
      built.traceLayer,
      built.silkscreenLayer,
      built.bottomLayer,
      built.topLayer,
    ].filter((child): child is NonNullable<typeof child> => child !== null);

    expect(root.slice(0, expected.length)).toEqual(expected);
    expect(root.indexOf(built.photoOverlayTop)).toBe(root.indexOf(built.outlineGfx) + 1);
    expect(root.indexOf(built.traceLayer!)).toBeGreaterThan(root.indexOf(built.photoOverlayBottom));
    expect(root.indexOf(built.silkscreenLayer!)).toBeGreaterThan(root.indexOf(built.traceLayer!));
    expect(root.indexOf(built.topLayer)).toBeGreaterThan(root.indexOf(built.silkscreenLayer!));

    expect(built.topLayer.getChildIndex(built.topFillLayer)).toBeLessThan(built.topLayer.getChildIndex(built.topPinLayer));
    expect(built.topLayer.getChildIndex(built.padsTop!)).toBeGreaterThan(built.topLayer.getChildIndex(built.topPinLayer));
    expect(built.topLayer.getChildIndex(built.padsTop!)).toBeLessThan(built.topLayer.getChildIndex(built.topOutlineLayer));
    expect(built.topLayer.getChildIndex(built.topOutlineLayer)).toBeLessThan(built.topLayer.getChildIndex(built.topLabelLayer));
  });

  it('hängt Bottom-Foto im Butterfly exakt mit dem Bottom-Board um und stellt die Reihenfolge wieder her', () => {
    const built = scene();
    const renderer = rendererWithoutConstructor();
    renderer.activeScene = built;
    renderer.viewport = new Container();
    renderer.netLinesGfx = new Graphics();
    renderer.selectionLabelLayer = new Container();
    renderer.butterflyDimGfx = new Graphics();
    renderer.butterflySelectionGfx = new Graphics();
    renderer.netDimGfx = new Graphics();
    renderer.crossSideGhostGfx = new Graphics();
    renderer.netLabelLayer = new Container();
    renderer.selectionGfx = new Graphics();
    renderer.discoHaloGfx = new Graphics();
    renderer.multiHighlightGfx = new Graphics();
    renderer.elevatedPinBg = new Graphics();
    renderer.elevatedPinLabel = new Container();
    renderer.elevatedPartBg = new Graphics();
    renderer.elevatedPartLabel = new Container();
    renderer.lastFlipParams = null;
    renderer.activeBoardColorHex = () => undefined;

    const restore = setActiveTab({
      butterfly: true, showTop: true, showBottom: true, rotation: 90,
      mirrorX: true, mirrorY: false, flipAxis: 'x',
    });
    try {
      (BoardRenderer.prototype as any).applyFlips.call(renderer, BOARD, built);

      expect(built.photoOverlayBottom.parent).toBe(built.butterflyRoot);
      expect(built.bottomLayer.parent).toBe(built.butterflyRoot);
      expect(built.butterflyRoot!.getChildIndex(built.photoOverlayBottom)).toBe(
        built.butterflyRoot!.getChildIndex(built.bottomLayer) - 1,
      );
      expect(built.photoOverlayBottom.toGlobal({ x: 120, y: 80 })).toEqual(
        built.bottomLayer.toGlobal({ x: 120, y: 80 }),
      );
      expect(built.photoOverlayTop.toGlobal({ x: 120, y: 80 })).toEqual(
        built.topLayer.toGlobal({ x: 120, y: 80 }),
      );

      (renderer.activeScene as BoardSceneGraph).root.updateTransform({});
      const butterflyRoot = built.butterflyRoot!;
      expect(butterflyRoot.position.x).not.toBe(0);
      expect(butterflyRoot.rotation).toBeCloseTo(Math.PI / 2);

      restore();
      const restoreNormal = setActiveTab({
        butterfly: false, showTop: false, showBottom: true, rotation: 180,
        mirrorX: false, mirrorY: true, flipAxis: 'y',
      });
      try {
        (BoardRenderer.prototype as any).applyFlips.call(renderer, BOARD, built);
        expect(built.photoOverlayBottom.parent).toBe(built.root);
        expect(built.bottomLayer.parent).toBe(built.root);
        expect(built.root.getChildIndex(built.photoOverlayBottom)).toBe(
          built.root.getChildIndex(built.photoOverlayTop) + 1,
        );
      } finally {
        restoreNormal();
      }
    } finally {
      // The nested normal-mode case restores its own tab; this is a no-op if
      // the first applyFlips assertion failed before that point.
      restore();
      built.root.destroy({ children: true });
      renderer.viewport.destroy({ children: true });
    }
  });

  it('wendet Side-Gates und Overlay-Visibility/Deckkraft pro Seite an', () => {
    const built = scene();
    const renderer = rendererWithoutConstructor();
    const restore = setActiveTab({
      butterfly: false, showTop: false, showBottom: true,
      showTraces: true, showComponents: true, showVias: false,
      showSilkscreen: true, showPads: true, showCopperDrops: false, showSurfaces: true,
      showPins: true, showOutlines: true, showLabels: true,
      layerStates: [], selectedLayerIndex: null, fixatedLayerIndex: null,
    });
    try {
      (BoardRenderer.prototype as any).applyLayerVisibility.call(renderer, built);
      expect(built.silkscreenTop!.visible).toBe(false);
      expect(built.silkscreenBottom!.visible).toBe(true);
      expect(built.padsTop!.visible).toBe(false);
      expect(built.padsBottom!.visible).toBe(true);
      expect(built.topLayer.visible).not.toBe(false);
      expect(built.topPinLayer.visible).toBe(true);

      const topMesh = { visible: true, alpha: 0 };
      const bottomMesh = { visible: true, alpha: 0 };
      renderer.photoOverlayRuntimes = new Map([
        ['top', { side: 'top', visible: true, opacity: 0.3, resources: { mesh: topMesh } }],
        ['bottom', { side: 'bottom', visible: true, opacity: 0.7, resources: { mesh: bottomMesh } }],
      ]);
      (BoardRenderer.prototype as any).applyPhotoOverlayVisibility.call(renderer);
      expect(topMesh).toMatchObject({ visible: false, alpha: 0.3 });
      expect(bottomMesh).toMatchObject({ visible: true, alpha: 0.7 });

      const restoreButterfly = setActiveTab({
        butterfly: true, showTop: false, showBottom: false,
      });
      try {
        (BoardRenderer.prototype as any).applyPhotoOverlayVisibility.call(renderer);
        expect(topMesh.visible).toBe(true);
        expect(bottomMesh.visible).toBe(true);
      } finally {
        restoreButterfly();
      }
    } finally {
      restore();
      built.root.destroy({ children: true });
    }
  });

  it('hält die Stencil-Maske renderbar, damit Pixi ihre Geometrie sammeln kann', () => {
    const renderer = rendererWithoutConstructor();
    const mask = (BoardRenderer.prototype as any).createOverlayMask.call(renderer, [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 },
    ]) as Graphics;
    const resources = createOverlayMesh(resourceBitmap(), buildOverlayMeshData(
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    ));
    resources.mesh.mask = mask;
    // Pixi's StencilMaskPipe sets includeInBuild=true while collecting the
    // mask. A non-renderable Graphics has localDisplayStatus 6, so the
    // collector exits before emitting any stencil geometry.
    expect(mask.renderable).toBe(true);
    expect(mask.localDisplayStatus).toBe(7);
    expect(mask.eventMode).toBe('none');
    expect(resources.mesh.mask).toBe(mask);
    resources.dispose();
    mask.destroy();
  });

  it('gibt Ersatz-/Szenenwechsel-Ressourcen idempotent frei und schließt kein Store-Bitmap', () => {
    const bitmap1 = resourceBitmap();
    const bitmap2 = resourceBitmap();
    const state = overlayState(bitmap1);
    const renderer = rendererWithoutConstructor();
    renderer.tabId = 41;
    renderer.board = BOARD;
    renderer.activeScene = scene();
    renderer.photoOverlayRuntimes = new Map();
    renderer.destroyed = false;
    renderer.needsRender = false;
    vi.spyOn(boardLifecycleController, 'getSubboardKey').mockReturnValue('board-key');
    vi.spyOn(photoOverlayStore, 'getBoardState').mockReturnValue(state);

    try {
      (BoardRenderer.prototype as any).syncPhotoOverlays.call(renderer);
      const first = renderer.photoOverlayRuntimes.get('top');
      expect(first).toBeTruthy();
      expect(first.resources.mesh.parent).toBe(renderer.activeScene.photoOverlayTop);
      expect(first.mask.parent).toBe(renderer.activeScene.photoOverlayTop);
      expect(renderer.activeScene.photoOverlayTop.parent).toBe(renderer.activeScene.root);
      expect(first.resources.mesh.visible).toBe(true);
      expect(first.resources.mesh.alpha).toBe(0.5);
      const disposeFirst = vi.spyOn(first.resources, 'dispose');
      const meshDestroy = vi.spyOn(first.resources.mesh, 'destroy');
      const textureDestroy = vi.spyOn(first.resources.texture, 'destroy');
      const geometryDestroy = vi.spyOn(first.resources.geometry, 'destroy');
      const maskDestroy = vi.spyOn(first.mask, 'destroy');
      state.sides.top.renderImage = bitmap2;

      (BoardRenderer.prototype as any).syncPhotoOverlays.call(renderer);
      expect(disposeFirst).toHaveBeenCalledTimes(1);
      expect(meshDestroy).toHaveBeenCalledTimes(1);
      expect(textureDestroy).toHaveBeenCalledTimes(1);
      expect(geometryDestroy).toHaveBeenCalledTimes(1);
      expect(maskDestroy).toHaveBeenCalledTimes(1);
      const second = renderer.photoOverlayRuntimes.get('top');
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      const disposeSecond = vi.spyOn(second.resources, 'dispose');

      renderer.activeScene = null;
      (BoardRenderer.prototype as any).syncPhotoOverlays.call(renderer);
      expect(renderer.photoOverlayRuntimes.size).toBe(0);
      expect(bitmap1.close).not.toHaveBeenCalled();
      expect(bitmap2.close).not.toHaveBeenCalled();
      expect(disposeSecond).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      renderer.activeScene?.root.destroy({ children: true });
    }
  });

  it('gibt Ressourcen auch in invalidate, deepPause und destroy genau einmal frei', () => {
    const cases = [
      {
        name: 'invalidate',
        prepare: (renderer: Record<string, any>) => {
          renderer.activeScene = null;
          renderer.sceneCache = new Map();
          renderer.hitGridCache = new Map();
        },
        run: (renderer: Record<string, any>) => {
          (BoardRenderer.prototype as any).invalidateAllScenes.call(renderer);
        },
      },
      {
        name: 'deepPause',
        prepare: (renderer: Record<string, any>) => {
          renderer.destroyed = false;
          renderer.contextLost = false;
          renderer.reinitializing = false;
          renderer.initialized = true;
          renderer.tabId = Number.MAX_SAFE_INTEGER;
          renderer.sceneCache = new Map();
          renderer.hitGridCache = new Map();
          renderer.teardownForReinit = function (this: Record<string, any>) {
            (BoardRenderer.prototype as any).invalidateAllScenes.call(this);
          };
        },
        run: (renderer: Record<string, any>) => {
          (BoardRenderer.prototype as any).deepPause.call(renderer);
        },
      },
      {
        name: 'destroy',
        prepare: (renderer: Record<string, any>) => {
          renderer.destroyed = false;
          renderer.initialized = true;
          renderer.tabId = null;
          renderer.activeScene = null;
          renderer.sceneCache = new Map();
          renderer.hitGridCache = new Map();
          renderer.containerEl = { removeEventListener: vi.fn() };
          renderer.teardownHalo = vi.fn();
          renderer.removeContextLossHandlers = vi.fn();
          renderer.hoverRafId = null;
          renderer.lastRenderedSel = { board: null };
        },
        run: (renderer: Record<string, any>) => {
          (BoardRenderer.prototype as any).destroy.call(renderer);
        },
      },
    ];

    for (const testCase of cases) {
      const renderer = rendererWithoutConstructor();
      const bitmap = resourceBitmap();
      const runtime = standaloneRuntime(renderer, bitmap);
      renderer.photoOverlayRuntimes = new Map([['top', runtime]]);
      testCase.prepare(renderer);
      vi.spyOn(runtime.resources.mesh, 'destroy');
      vi.spyOn(runtime.resources.texture, 'destroy');
      vi.spyOn(runtime.resources.geometry, 'destroy');
      vi.spyOn(runtime.mask, 'destroy');

      testCase.run(renderer);

      expectFreedOnce(runtime, bitmap);
      expect(renderer.photoOverlayRuntimes.size).toBe(0);
      expect(testCase.name).toMatch(/invalidate|deepPause|destroy/);
    }
  });

  it('entfernt nur das betroffene Overlay bei degenerierter Kalibrierung', () => {
    const bitmap = resourceBitmap();
    const state = overlayState(bitmap);
    const renderer = rendererWithoutConstructor();
    renderer.tabId = 42;
    renderer.board = BOARD;
    renderer.activeScene = scene();
    renderer.photoOverlayRuntimes = new Map();
    renderer.destroyed = false;
    vi.spyOn(boardLifecycleController, 'getSubboardKey').mockReturnValue('board-key');
    vi.spyOn(photoOverlayStore, 'getBoardState').mockReturnValue(state);

    try {
      expect(() => (BoardRenderer.prototype as any).syncPhotoOverlays.call(renderer)).not.toThrow();
      const old = renderer.photoOverlayRuntimes.get('top');
      expect(old).toBeTruthy();
      const dispose = vi.spyOn(old.resources, 'dispose');
      state.sides.top.calibration = {
        ...validCalibration(),
        points: [
          { id: 1, board: { x: 0, y: 0 }, photo: { x: 0, y: 0 } },
          { id: 2, board: { x: 0.5, y: 0.5 }, photo: { x: 0.5, y: 0.5 } },
          { id: 3, board: { x: 1, y: 1 }, photo: { x: 1, y: 1 } },
          { id: 4, board: { x: 0.25, y: 0.25 }, photo: { x: 0.25, y: 0.25 } },
        ],
      };
      (BoardRenderer.prototype as any).syncPhotoOverlays.call(renderer);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(renderer.photoOverlayRuntimes.has('top')).toBe(false);
      expect(bitmap.close).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      renderer.activeScene?.root.destroy({ children: true });
    }
  });
});
