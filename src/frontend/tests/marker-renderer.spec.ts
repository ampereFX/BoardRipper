import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/test-board.bvr');
const PHOTO = path.resolve(HERE, '../public/icon-512.png');

const calibration = {
  version: 1,
  points: [
    { id: 1, board: { x: 0.1, y: 0.1 }, photo: { x: 0.1, y: 0.1 } },
    { id: 2, board: { x: 0.9, y: 0.1 }, photo: { x: 0.9, y: 0.1 } },
    { id: 3, board: { x: 0.9, y: 0.9 }, photo: { x: 0.9, y: 0.9 } },
    { id: 4, board: { x: 0.1, y: 0.9 }, photo: { x: 0.1, y: 0.9 } },
  ],
};

interface TestPoint { x: number; y: number }
interface TestContainer { toGlobal(point: TestPoint): TestPoint }
interface TestRenderer {
  activeScene: {
    markerRootTop: TestContainer;
    markerRootBottom: TestContainer;
    root: TestContainer;
    butterflyRoot: TestContainer | null;
  };
  drawPositionMarkers(): void;
  markerEntries: unknown[];
  photoOverlayRuntimes: Map<string, unknown>;
  selectionLabelLayer: TestContainer;
  viewport: { scale: { x: number; y: number; set(x: number, y: number): void }; children: TestContainer[] };
  app: { stage: { children: TestContainer[] } };
  markerScreenPoints(side: 'top' | 'bottom'): Array<{ id: string; x: number; y: number }>;
  markerAtScreenPoint(x: number, y: number): string | null;
  tooltipCanvas: HTMLCanvasElement;
  fitToBoard(): void;
}
interface TestMarker {
  id: string;
  x: number;
  y: number;
  side: 'top' | 'bottom';
}
interface TestMarkerStore {
  resolveIdentity(tabId: number, index: number): Promise<{ fileKey: string; subboardKey: string; bounds: { minX: number; minY: number; maxX: number; maxY: number } }>;
  getById(id: string): TestMarker | null;
  getSnapshot(): { selectedMarkerId: string | null };
  create(input: { fileKey: string; subboardKey: string; x: number; y: number; side: 'top' | 'bottom'; name: string; net: null; note: string; color: string; context: string }): Promise<TestMarker>;
  remove(id: string): Promise<unknown>;
}
interface TestBoardStore { activeTabId: number; butterfly: boolean; toggleHoverInfo(): void }
interface MarkerTestWindow extends Window {
  __boardRenderer: TestRenderer;
  __markerStore: TestMarkerStore;
  __boardStore: TestBoardStore;
}

async function markerMetrics(page: Page, markerId: string) {
  return page.evaluate(async (id) => {
    const w = window as unknown as MarkerTestWindow;
    const renderer = w.__boardRenderer;
    const store = w.__markerStore;
    const marker = store.getById(id);
    renderer.drawPositionMarkers();
    const scene = renderer.activeScene;
    const sideRoot = marker.side === 'bottom' ? scene.markerRootBottom : scene.markerRootTop;
    const markerPoint = renderer.markerScreenPoints(marker.side)[0];
    const anchor = sideRoot.toGlobal({ x: markerPoint.x, y: markerPoint.y });
    const tip = sideRoot.toGlobal({ x: markerPoint.x, y: markerPoint.y - 15 });
    const stageChildren = renderer.app.stage.children;
    return {
      glyphHeightPx: Math.hypot(anchor.x - tip.x, anchor.y - tip.y),
      transformErrorPx: Math.hypot(anchor.x - markerPoint.x, anchor.y - markerPoint.y),
      markerAboveBoard: stageChildren.indexOf(sideRoot) > stageChildren.indexOf(renderer.viewport),
      markerAboveSelection: stageChildren.indexOf(sideRoot) > stageChildren.indexOf(renderer.viewport),
      photoOverlayCount: renderer.photoOverlayRuntimes.size,
    };
  }, markerId);
}

test('position markers keep their screen size and follow board transforms', async ({ page }) => {
  const photo = fs.readFileSync(PHOTO);
  await page.route('**/api/board-photo-assets/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith('/overlays/top/render')) {
      await route.fulfill({ status: 200, contentType: 'image/png', body: photo });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mask: null,
        overlays: {
          top: {
            metadata: { id: 'marker-render-test', mimeType: 'image/png', widthPx: 512, heightPx: 512 },
            calibration,
          },
        },
      }),
    });
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await expect(page.getByTestId('board-overlay-bar')).toBeVisible();
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<MarkerTestWindow>;
    return !!w.__markerStore && !!w.__boardRenderer?.activeScene;
  });
  await page.waitForFunction(() => (window as unknown as MarkerTestWindow).__boardRenderer.photoOverlayRuntimes.size > 0);

  const ids = await page.evaluate(async () => {
    const w = window as unknown as MarkerTestWindow;
    const tabId = w.__boardStore.activeTabId;
    const identity = await w.__markerStore.resolveIdentity(tabId, 0);
    const common = {
      fileKey: identity.fileKey,
      subboardKey: identity.subboardKey,
      x: 0.5,
      y: 0.5,
      name: 'Transform test',
      net: null,
      note: 'Marker note',
      color: '#e53935',
      context: 'J4 · Pin 1',
    };
    const top = await w.__markerStore.create({ ...common, side: 'top' });
    const bottom = await w.__markerStore.create({ ...common, side: 'bottom' });
    return [top.id, bottom.id] as string[];
  });

  await expect.poll(() => page.evaluate(() => (window as unknown as MarkerTestWindow).__boardRenderer.markerEntries.length)).toBe(2);
  const topId = ids[0];
  const bottomId = ids[1];
  const bar = page.getByTestId('board-overlay-bar');
  await page.evaluate(() => (window as unknown as MarkerTestWindow).__boardStore.toggleHoverInfo());

  for (const scale of [0.42, 0.86, 1.35]) {
    await page.evaluate((value) => {
      const renderer = (window as unknown as MarkerTestWindow).__boardRenderer;
      renderer.viewport.scale.set(value, value);
      renderer.drawPositionMarkers();
    }, scale);
    const topMetrics = await markerMetrics(page, topId);
    expect(topMetrics.glyphHeightPx).toBeCloseTo(15, 0);
    expect(topMetrics.transformErrorPx).toBeLessThan(0.1);
    expect(topMetrics.markerAboveBoard).toBe(true);
    expect(topMetrics.markerAboveSelection).toBe(true);
    expect(topMetrics.photoOverlayCount).toBeGreaterThan(0);
  }

  await page.evaluate(() => (window as unknown as MarkerTestWindow).__boardRenderer.fitToBoard());
  await page.waitForTimeout(300);
  const hover = await page.evaluate((id) => {
    const w = window as unknown as MarkerTestWindow;
    const point = w.__boardRenderer.markerScreenPoints('top').find(item => item.id === id)!;
    const canvas = w.__boardRenderer.tooltipCanvas;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + point.x, y: rect.top + point.y, localX: point.x, localY: point.y, hit: w.__boardRenderer.markerAtScreenPoint(point.x, point.y) };
  }, topId);
  expect(hover.hit).toBe(topId);
  await page.mouse.move(hover.x, hover.y);
  const tooltip = page.locator('.pin-net-tooltip');
  await expect(tooltip).toContainText('Transform test');
  await expect(tooltip).toContainText('J4 · Pin 1');
  await expect(tooltip).toContainText('Marker note');
  await page.mouse.click(hover.x, hover.y);
  await expect(page.getByTestId('marker-panel')).toBeVisible();
  await expect(page.getByTestId(`marker-row-${topId}`)).toHaveClass(/is-selected/);
  expect(await page.evaluate(() => (window as unknown as MarkerTestWindow).__markerStore.getSnapshot().selectedMarkerId)).toBe(topId);

  await bar.getByTestId('rotate-cw').click();
  const rotated = await markerMetrics(page, topId);
  expect(rotated.transformErrorPx).toBeLessThan(0.1);
  expect(rotated.glyphHeightPx).toBeCloseTo(15, 0);

  await bar.getByTestId('butterfly-btn').click();
  await expect(bar.getByTestId('butterfly-btn')).toHaveClass(/active/);
  const bottomMetrics = await markerMetrics(page, bottomId);
  expect(bottomMetrics.transformErrorPx).toBeLessThan(0.1);
  expect(bottomMetrics.glyphHeightPx).toBeCloseTo(15, 0);
  expect(bottomMetrics.markerAboveBoard).toBe(true);

  await page.evaluate(async (markerIds) => {
    const store = (window as unknown as MarkerTestWindow).__markerStore;
    await Promise.all(markerIds.map((id) => store.remove(id)));
  }, ids);
});
