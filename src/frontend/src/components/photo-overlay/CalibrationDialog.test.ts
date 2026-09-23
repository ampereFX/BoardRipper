// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CalibrationDialog, type CalibrationBoardViewModel } from './CalibrationDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToBlob = HTMLCanvasElement.prototype.toBlob;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

const board: CalibrationBoardViewModel = {
  outline: [{ x: 0.05, y: 0.05 }, { x: 0.95, y: 0.05 }, { x: 0.95, y: 0.95 }, { x: 0.05, y: 0.95 }],
  pads: [{ x: 0.2, y: 0.2, width: 0.08, height: 0.04 }],
  holes: [{ x: 0.3, y: 0.3 }],
  vias: [{ x: 0.7, y: 0.7 }],
  components: [{ label: 'U1', bounds: { x: 0.4, y: 0.4, width: 0.2, height: 0.15 }, pins: [{ x: 0.42, y: 0.42 }] }],
};

function render(element: ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => root.render(element));
  return container;
}

function pointer(canvas: HTMLCanvasElement, type: string, x: number, y: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: 1 },
    button: { value: 0 },
    altKey: { value: false },
    shiftKey: { value: false },
  });
  act(() => canvas.dispatchEvent(event));
}

function addPair(container: HTMLDivElement, boardX: number, boardY: number, photoX = boardX, photoY = boardY): void {
  pointer(container.querySelector<HTMLCanvasElement>('[data-testid="photo-overlay-reference-canvas"]')!, 'pointerdown', boardX, boardY);
  pointer(container.querySelector<HTMLCanvasElement>('[data-testid="photo-overlay-photo-canvas"]')!, 'pointerdown', photoX, photoY);
}

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => ({
      beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), arc: vi.fn(),
      stroke: vi.fn(), fill: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(),
      fillText: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
    })),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: vi.fn((callback: BlobCallback, type?: string) => callback(new Blob(['normalized'], { type }))),
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test-photo') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: vi.fn(async () => ({ width: 640, height: 400, close: vi.fn() })),
  });
});

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: originalGetContext });
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', { configurable: true, value: originalToBlob });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL });
});

describe('CalibrationDialog', () => {
  it('führt vier Paare, zeigt Vorschau-Modi und speichert beim Erstimport den normalisierten Blob', async () => {
    const onSave = vi.fn();
    const container = render(createElement(CalibrationDialog, { board, imageBlob: new Blob(['photo'], { type: 'image/png' }), onSave, onCancel: vi.fn() }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    addPair(container, 80, 60);
    addPair(container, 560, 60);
    addPair(container, 560, 340);
    addPair(container, 80, 340);


    expect(container.querySelector('[data-testid="photo-overlay-calibration-count"]')?.textContent).toContain('4/12');
    expect(container.querySelector('[data-testid="photo-overlay-preview-mode-compare"]')).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-preview-mode-compare"]')?.click());
    expect(container.querySelector('[data-testid="photo-overlay-calibration-preview"]')).not.toBeNull();

    const saveButton = container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-calibration-save"]')!;
    act(() => saveButton.click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mode: 'import', photoBlob: expect.any(Blob) }));
  });

  it('erlaubt Auswahl und Löschen sowie eine manuelle Maske ohne verlässliche Outline', () => {
    const onSave = vi.fn();
    const unreliableBoard = { ...board, outlineReliable: false };
    const container = render(createElement(CalibrationDialog, { board: unreliableBoard, mode: 'recalibrate', onSave, onCancel: vi.fn() }));

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-manual-mask-mode"]')?.click());
    addPair(container, 80, 60);
    addPair(container, 560, 60);
    addPair(container, 560, 340);
    addPair(container, 80, 340);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-calibration-pair-1"]')?.click());
    expect(container.querySelector('[data-testid="photo-overlay-calibration-pair-1"]')?.getAttribute('aria-current')).toBe('true');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-delete-selection"]')?.click());
    expect(container.querySelector('[data-testid="photo-overlay-calibration-count"]')?.textContent).toContain('3/12');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-manual-mask-mode"]')?.click());
    const boardCanvas = container.querySelector<HTMLCanvasElement>('[data-testid="photo-overlay-reference-canvas"]')!;
    const photoCanvas = container.querySelector<HTMLCanvasElement>('[data-testid="photo-overlay-photo-canvas"]')!;
    pointer(boardCanvas, 'pointerdown', 100, 100);
    pointer(boardCanvas, 'pointerdown', 540, 100);
    pointer(boardCanvas, 'pointerdown', 540, 300);
    expect(container.querySelector('[data-testid="photo-overlay-manual-mask-points"]')?.textContent).toContain('3 Maskenpunkte');
    pointer(photoCanvas, 'pointerdown', 100, 100);
    expect(container.querySelector('[data-testid="photo-overlay-manual-mask-points"]')?.textContent).toContain('3 Maskenpunkte');
  });

  it('ermöglicht das Speichern mit vier Kalibrierpaaren und gültiger Boardmaske', () => {
    const onSave = vi.fn();
    const unreliableBoard = { ...board, outlineReliable: false };
    const container = render(createElement(CalibrationDialog, { board: unreliableBoard, mode: 'recalibrate', onSave, onCancel: vi.fn() }));

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-manual-mask-mode"]')?.click());
    addPair(container, 80, 60);
    addPair(container, 560, 60);
    addPair(container, 560, 340);
    addPair(container, 80, 340);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-manual-mask-mode"]')?.click());

    const boardCanvas = container.querySelector<HTMLCanvasElement>('[data-testid="photo-overlay-reference-canvas"]')!;
    pointer(boardCanvas, 'pointerdown', 100, 100);
    pointer(boardCanvas, 'pointerdown', 540, 100);
    pointer(boardCanvas, 'pointerdown', 540, 300);

    const saveButton = container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-calibration-save"]')!;
    expect(saveButton.disabled).toBe(false);
    act(() => saveButton.click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mode: 'recalibrate', manualMask: { points: expect.any(Array) } }));
  });

  it('verlangt ab fünf Paaren eine explizite Bestätigung vor dem Speichern', async () => {
    const onSave = vi.fn();
    const container = render(createElement(CalibrationDialog, { board, imageBlob: new Blob(['photo'], { type: 'image/png' }), onSave, onCancel: vi.fn() }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    addPair(container, 80, 60);
    addPair(container, 560, 60);
    addPair(container, 560, 340);
    addPair(container, 80, 340);
    addPair(container, 320, 200, 590, 100);

    expect(container.querySelector('[data-testid="photo-overlay-confirm-warning"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-calibration-save"]')?.disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-confirm-warning"]')?.click());
    expect(container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-calibration-save"]')?.disabled).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-calibration-save"]')?.click());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('gibt Cancel unverändert nach außen und räumt Object-URLs beim Unmount auf', async () => {
    const onCancel = vi.fn();
    const container = render(createElement(CalibrationDialog, { board, imageBlob: new Blob(['photo'], { type: 'image/jpeg' }), onSave: vi.fn(), onCancel }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    addPair(container, 80, 60);
    act(() => container.querySelector<HTMLButtonElement>('.photo-overlay-calibration__close')?.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => mounted[0].root.unmount());
    const revoke = URL.revokeObjectURL as ReturnType<typeof vi.fn>;
    expect(revoke).toHaveBeenCalledWith('blob:test-photo');
  });
});
