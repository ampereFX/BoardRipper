import { test, expect, chromium, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(__dirname, '../public/samples/test-board.bvr');

async function loadBoard(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.locator('.dv-tab', { hasText: 'test-board.bvr' })).toBeVisible({ timeout: 15000 });
  await page.locator('.dv-tab', { hasText: 'test-board.bvr' }).click();
  await page.waitForFunction(() => {
    const store = (window as unknown as { __boardStore?: { activeTab?: { board: unknown } } }).__boardStore;
    return store?.activeTab?.board != null;
  }, undefined, { timeout: 15000 });
}

async function waitForRestoredBoard(page: Page) {
  const reopenDialog = page.getByRole('dialog');
  if (await reopenDialog.isVisible().catch(() => false)) {
    await reopenDialog.getByRole('button', { name: 'Reopen' }).click();
  }
  await expect(page.locator('.dv-tab', { hasText: 'test-board.bvr' })).toBeVisible({ timeout: 15000 });
  await page.locator('.dv-tab', { hasText: 'test-board.bvr' }).click();
  await page.waitForFunction(() => {
    const store = (window as unknown as { __boardStore?: { activeTab?: { board: unknown } } }).__boardStore;
    return store?.activeTab?.board != null;
  }, undefined, { timeout: 15000 });
}

async function openMarkersTab(page: Page) {
  const boardTab = page.locator('.dv-tab', { hasText: 'test-board.bvr' });
  if (await boardTab.isVisible().catch(() => false)) await boardTab.click();
  const markerTab = page.locator('[data-board-tab="markers"]');
  if (!(await markerTab.isVisible().catch(() => false))) {
    await page.locator('.board-sidebar-toggle').first().click();
  }
  await markerTab.click();
}

async function hoverMarkerNote(page: Page, markerId: string) {
  await page.waitForFunction((id) => {
    const renderer = (window as unknown as { __boardRenderer?: { markerEntries?: Array<{ marker: { id: string; note: string } }> } }).__boardRenderer;
    return renderer?.markerEntries?.some((entry) => entry.marker.id === id && entry.marker.note.includes('Check this power rail'));
  }, markerId);
  await page.evaluate((id) => {
    const renderer = (window as unknown as {
      __boardRenderer?: {
        markerScreenPoints: (side: 'top' | 'bottom') => Array<{ id: string; x: number; y: number }>;
        handleHover: (event: { offsetX: number; offsetY: number }) => void;
      };
    }).__boardRenderer;
    if (!renderer) throw new Error('Board renderer is not available');
    const marker = [...renderer.markerScreenPoints('top'), ...renderer.markerScreenPoints('bottom')]
      .find((point) => point.id === id);
    if (!marker) throw new Error('Marker was not rendered on the board');
    renderer.handleHover({ offsetX: marker.x, offsetY: marker.y });
  }, markerId);
}

async function openSpotMenu(page: Page, side: 'top' | 'bottom' | 'both' = 'top') {
  await page.evaluate((markerSide) => {
    const win = window as unknown as {
      __boardStore?: { activeTab?: { id: number; board?: { bounds: { minX: number; minY: number; maxX: number; maxY: number } } } };
      __contextMenuStore?: { showBoard: (x: number, y: number, name: string, pin: string | null, net: string | null, overlap: string[], spot: unknown) => void };
    };
    const tab = win.__boardStore?.activeTab;
    const bounds = tab?.board?.bounds;
    if (!tab || !bounds) throw new Error('Board was not loaded');
    win.__contextMenuStore?.showBoard(180, 180, '', null, null, [], {
      tabId: tab.id,
      subboardIndex: null,
      boardX: (bounds.minX + bounds.maxX) / 2,
      boardY: (bounds.minY + bounds.maxY) / 2,
      side: markerSide,
      kind: 'free',
      contextLabel: 'Board location',
    });
  }, side);
}

test('create a marker, edit it, navigate to it, and keep it after reload', async ({ page }) => {
  const markerName = `Marker e2e ${Date.now()}`;
  await loadBoard(page);
  await openSpotMenu(page);

  await expect(page.getByTestId('mark-this-spot')).toContainText('Mark this spot');
  await page.getByTestId('mark-this-spot').click();
  await expect(page.getByTestId('marker-panel')).toBeVisible();
  await expect(page.locator('.marker-row__field textarea')).toBeFocused();

  const name = page.locator('.marker-row__field input').first();
  const note = page.locator('.marker-row__field textarea').first();
  await name.fill(markerName);
  await note.fill('Check this power rail before replacing the connector.');
  await page.getByRole('button', { name: 'Farbe #4d91d0' }).click();
  await expect(page.locator('.toast', { hasText: 'Marker hinzugefügt' })).toBeVisible();

  const row = page.locator('.marker-row').filter({ hasText: markerName });
  await expect(row).toContainText('Board location');
  await expect(row).toContainText('Top');
  const testId = await row.getAttribute('data-testid');
  const markerId = testId?.replace('marker-row-', '');
  if (!markerId) throw new Error('Marker id is missing from its row');
  await hoverMarkerNote(page, markerId);
  await expect(page.locator('.pnt-marker-note')).toContainText('Check this power rail before replacing the connector.');
  await row.locator('.marker-row__navigate').click();
  await expect(row).toHaveClass(/is-selected/);
  await page.screenshot({ path: '/tmp/boardripper-marker-panel.png', fullPage: true });

  await page.reload();
  await waitForRestoredBoard(page);
  await openMarkersTab(page);
  await page.getByTestId('marker-search').fill(markerName);
  const restoredRow = page.locator('.marker-row').filter({ hasText: markerName });
  await expect(restoredRow).toContainText('Check this power rail');
  await expect(restoredRow.locator('.marker-row__swatch')).toHaveCSS('background-color', 'rgb(77, 145, 208)');
  await restoredRow.locator('.marker-row__navigate').click();
  await expect(restoredRow).toHaveClass(/is-selected/);

  await restoredRow.getByRole('button', { name: `Marker ${markerName} löschen` }).click();
  await page.getByRole('button', { name: 'Rückgängig' }).click();
  await expect(restoredRow).toBeVisible();
});

test('ambiguous two-side spots require a side choice and empty clicks show no donor actions', async ({ page }) => {
  await loadBoard(page);
  await openSpotMenu(page, 'both');

  await page.getByTestId('mark-this-spot').click();
  await expect(page.getByTestId('marker-side-choices')).toBeVisible();
  await expect(page.getByTestId('mark-spot-top')).toBeVisible();
  await expect(page.getByTestId('mark-spot-bottom')).toBeVisible();
  await expect(page.getByTestId('mark-spot-both')).toBeVisible();
  await expect(page.locator('.context-menu-item', { hasText: "Search '' in PDF" })).toHaveCount(0);
  await expect(page.locator('.context-menu-search-donors')).toHaveCount(0);
});

test('a real canvas right-click exposes marker actions with its board location', async ({ page }) => {
  await loadBoard(page);
  const canvas = page.getByTestId('board-canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Board canvas is not visible');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { button: 'right' });

  await expect(page.locator('.context-menu')).toBeVisible();
  await expect(page.getByTestId('marker-location')).toBeVisible();
  await expect(page.getByTestId('mark-this-spot')).toBeVisible();
  await expect(page.getByTestId('marker-location')).toContainText('mil');
});

test('marker data survives closing and reopening the browser profile', async () => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'boardripper-marker-profile-'));
  const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.VITE_PORT ?? '18083'}`;
  let context = await chromium.launchPersistentContext(profileDir, { headless: true });
  try {
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(baseUrl);
    await page.getByTestId('file-input').setInputFiles(BOARD);
    await expect(page.locator('.dv-tab', { hasText: 'test-board.bvr' })).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(() => {
      const store = (window as unknown as { __boardStore?: { activeTab?: { board: unknown } } }).__boardStore;
      return store?.activeTab?.board != null;
    }, undefined, { timeout: 15000 });

    const markerName = `Restart marker ${Date.now()}`;
    await openSpotMenu(page);
    await page.getByTestId('mark-this-spot').click();
    await page.locator('.marker-row__field input').first().fill(markerName);
    await page.locator('.marker-row__field textarea').first().fill('Persists across browser close.');
    await expect(page.locator('.marker-row').filter({ hasText: markerName })).toBeVisible();
    await expect(page.locator('.marker-row__status')).toHaveText('Gespeichert');
    await context.close();

    context = await chromium.launchPersistentContext(profileDir, { headless: true });
    page = context.pages()[0] ?? await context.newPage();
    await page.goto(baseUrl);
    const reopenDialog = page.getByRole('dialog');
    if (await reopenDialog.isVisible().catch(() => false)) {
      await reopenDialog.getByRole('button', { name: 'Discard' }).click();
    }
    await page.getByTestId('file-input').setInputFiles(BOARD);
    await expect(page.locator('.dv-tab', { hasText: 'test-board.bvr' })).toBeVisible({ timeout: 15000 });
    await page.locator('.dv-tab', { hasText: 'test-board.bvr' }).click();
    await page.waitForFunction(() => {
      const store = (window as unknown as { __boardStore?: { activeTab?: { board: unknown } } }).__boardStore;
      return store?.activeTab?.board != null;
    }, undefined, { timeout: 15000 });
    await openMarkersTab(page);
    await page.getByTestId('marker-search').fill(markerName);
    await expect(page.locator('.marker-row').filter({ hasText: markerName }))
      .toContainText('Persists across browser close.');
  } finally {
    await context.close();
    await fs.rm(profileDir, { recursive: true, force: true });
  }
});
