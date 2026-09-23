import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD_FILE = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');
const PHOTO_FILE = path.resolve(HERE, '../public/icon-512.png');

const calibration = {
  version: 1,
  points: [
    { id: 1, board: { x: 0.0899, y: 0.0919 }, photo: { x: 0.0917, y: 0.0919 } },
    { id: 2, board: { x: 0.8789, y: 0.0919 }, photo: { x: 0.8991, y: 0.0919 } },
    { id: 3, board: { x: 0.8789, y: 0.8552 }, photo: { x: 0.8991, y: 0.8552 } },
    { id: 4, board: { x: 0.0899, y: 0.8552 }, photo: { x: 0.0917, y: 0.8552 } },
  ],
};

async function changedBoardPixels(
  page: import('@playwright/test').Page,
  before: Buffer,
  after: Buffer,
): Promise<number> {
  return page.evaluate(async ({ beforePng, afterPng }) => {
    const decode = async (base64: string): Promise<ImageData> => {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };

    const [left, right] = await Promise.all([decode(beforePng), decode(afterPng)]);
    if (left.width !== right.width || left.height !== right.height) return 0;

    let changed = 0;
    const marginX = Math.floor(left.width * 0.08);
    const marginY = Math.floor(left.height * 0.08);
    for (let y = marginY; y < left.height - marginY; y++) {
      for (let x = marginX; x < left.width - marginX; x++) {
        const i = (y * left.width + x) * 4;
        const difference = Math.abs(left.data[i] - right.data[i])
          + Math.abs(left.data[i + 1] - right.data[i + 1])
          + Math.abs(left.data[i + 2] - right.data[i + 2]);
        if (difference > 36) changed++;
      }
    }
    return changed;
  }, {
    beforePng: before.toString('base64'),
    afterPng: after.toString('base64'),
  });
}

test('PCB-Foto-Overlay wird auf der Boardfläche gerendert und lässt sich ausblenden', async ({ page }) => {
  const photo = fs.readFileSync(PHOTO_FILE);
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
            metadata: { id: 'e2e-icon', mimeType: 'image/png', widthPx: 512, heightPx: 512 },
            calibration,
          },
        },
      }),
    });
  });

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD_FILE);
  await expect(page.getByTestId('board-overlay-bar')).toBeVisible({ timeout: 15000 });

  // Clear pads that could cover the photo and measure only the Pixi board canvas,
  // never the photo card preview or its controls.
  await page.locator('.board-sidebar-toggle').click();
  const sidebar = page.locator('.board-sidebar');
  await sidebar.getByRole('button', { name: /Fotos/ }).click();
  await expect(page.getByTestId('photo-overlay-status-top')).toHaveText('Bereit');
  await expect(page.getByTestId('photo-overlay-opacity-top')).toHaveValue('0.5');
  await expect(page.getByTestId('photo-overlay-visible-top')).toBeChecked();

  await sidebar.getByRole('button', { name: 'Layers' }).click();
  const padsToggle = sidebar.getByRole('button', { name: /Pads/ });
  await expect(padsToggle).toBeVisible();
  if (!await padsToggle.getAttribute('class').then(value => value?.includes('off') ?? false)) {
    await padsToggle.click();
  }
  await sidebar.getByRole('button', { name: /Fotos/ }).click();

  const boardCanvas = page.getByTestId('board-canvas').locator('canvas').first();
  await expect(boardCanvas).toBeVisible();
  await page.waitForTimeout(500);
  const withPhoto = await boardCanvas.screenshot();

  await page.getByTestId('photo-overlay-visible-top').uncheck();
  await page.waitForTimeout(250);
  const withoutPhoto = await boardCanvas.screenshot();

  const changedPixels = await changedBoardPixels(page, withPhoto, withoutPhoto);
  expect(changedPixels, 'das Foto muss die Boardfläche sichtbar verändern').toBeGreaterThan(1000);
});
