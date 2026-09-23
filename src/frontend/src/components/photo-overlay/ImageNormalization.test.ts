// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePhotoImage } from './ImageNormalization';

interface BitmapMock {
  width: number;
  height: number;
  close: ReturnType<typeof vi.fn>;
}

const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToBlob = HTMLCanvasElement.prototype.toBlob;

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => ({ drawImage: vi.fn() })),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: vi.fn((callback: BlobCallback, type?: string) => callback(new Blob(['normalized'], { type }))),
  });
});

afterEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: originalGetContext });
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', { configurable: true, value: originalToBlob });
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: originalCreateImageBitmap });
});

describe('normalizePhotoImage', () => {
  it('normalisiert JPEG und übergibt die EXIF-Orientierung an createImageBitmap', async () => {
    const bitmap: BitmapMock = { width: 900, height: 600, close: vi.fn() };
    const createImageBitmap = vi.fn(async () => bitmap);
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: createImageBitmap });

    const result = await normalizePhotoImage(new Blob(['jpeg'], { type: 'image/jpeg' }));

    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: 'from-image' });
    expect(result.width).toBe(900);
    expect(result.height).toBe(600);
    expect(result.blob.type).toBe('image/jpeg');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('normalisiert PNG und gibt Ressourcen auch bei Canvas-Fehlern frei', async () => {
    const bitmap: BitmapMock = { width: 400, height: 700, close: vi.fn() };
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: vi.fn(async () => bitmap) });
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
      configurable: true,
      value: vi.fn(() => { throw new Error('canvas failed'); }),
    });

    await expect(normalizePhotoImage(new Blob(['png'], { type: 'image/png' }))).rejects.toThrow('canvas failed');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('lehnt HEIC und andere nicht unterstützte Bildtypen ohne Dekodierung ab', async () => {
    const createImageBitmap = vi.fn();
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: createImageBitmap });

    await expect(normalizePhotoImage(new Blob(['heic'], { type: 'image/heic' }))).rejects.toThrow('JPEG- und PNG');
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
