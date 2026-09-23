// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OverlaySide } from '../../photo-overlay/types';
import { PhotoOverlayCard } from './PhotoOverlayCard';
import type { PhotoOverlayCardProps } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function cardProps(side: OverlaySide, overrides: Partial<PhotoOverlayCardProps> = {}): PhotoOverlayCardProps {
  return {
    side,
    status: 'ready',
    metadata: { id: `${side}-asset`, mimeType: 'image/jpeg', widthPx: 1600, heightPx: 900 },
    previewUrl: `/preview-${side}.jpg`,
    error: null,
    visible: true,
    opacity: 0.5,
    onImport: vi.fn(),
    onVisibilityChange: vi.fn(),
    onOpacityChange: vi.fn(),
    onRecalibrate: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
}

function render(element: ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => root.render(element));
  return container;
}

function drop(container: HTMLDivElement, side: OverlaySide, file: File): void {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
  act(() => container.querySelector<HTMLButtonElement>(`[data-testid="photo-overlay-dropzone-${side}"]`)?.dispatchEvent(event));
}

describe('PhotoOverlayCard', () => {
  it.each<OverlaySide>(['top', 'bottom'])('renders the %s side and its preview', (side) => {
    const container = render(createElement(PhotoOverlayCard, cardProps(side)));

    expect(container.querySelector(`[data-testid="photo-overlay-card-${side}"]`)).not.toBeNull();
    expect(container.textContent).toContain(side === 'top' ? 'Oberseite' : 'Unterseite');
    expect(container.querySelector<HTMLInputElement>(`[data-testid="photo-overlay-file-input-${side}"]`)
      ?.getAttribute('aria-label')).toBe(`JPEG oder PNG für die ${side === 'top' ? 'Oberseite' : 'Unterseite'} auswählen`);
    expect(container.querySelector<HTMLButtonElement>(`[data-testid="photo-overlay-dropzone-${side}"]`)
      ?.getAttribute('aria-label')).toBe(`JPEG oder PNG für die ${side === 'top' ? 'Oberseite' : 'Unterseite'} auswählen oder hier ablegen`);
    expect(container.querySelector(`img[src="/preview-${side}.jpg"]`)).not.toBeNull();
  });

  it('reports a valid dropped JPEG with the side', () => {
    const props = cardProps('top');
    const container = render(createElement(PhotoOverlayCard, props));
    const file = new File(['jpeg'], 'board-photo.jpg', { type: 'image/jpeg' });

    drop(container, 'top', file);

    expect(props.onImport).toHaveBeenCalledWith(file, 'top');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('rejects an invalid dropped file and does not import it', () => {
    const props = cardProps('bottom');
    const container = render(createElement(PhotoOverlayCard, props));
    drop(container, 'bottom', new File(['gif'], 'board-photo.gif', { type: 'image/gif' }));

    expect(props.onImport).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="photo-overlay-file-error-bottom"]')?.textContent)
      .toContain('Nur Bilder im Format JPEG');
  });

  it('validates picker files and clears the input after handling them', () => {
    const props = cardProps('top');
    const container = render(createElement(PhotoOverlayCard, props));
    const input = container.querySelector<HTMLInputElement>('[data-testid="photo-overlay-file-input-top"]')!;
    const file = new File(['png'], 'board-photo.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });

    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));

    expect(props.onImport).toHaveBeenCalledWith(file, 'top');
    expect(input.value).toBe('');
  });

  it('calls visibility, opacity and recalibration callbacks', () => {
    const props = cardProps('top');
    const container = render(createElement(PhotoOverlayCard, props));
    const visibility = container.querySelector<HTMLInputElement>('[data-testid="photo-overlay-visible-top"]')!;
    const opacity = container.querySelector<HTMLInputElement>('[data-testid="photo-overlay-opacity-top"]')!;

    act(() => visibility.click());
    opacity.value = '0.8';
    act(() => opacity.dispatchEvent(new Event('input', { bubbles: true })));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-recalibrate-top"]')?.click());

    expect(props.onVisibilityChange).toHaveBeenCalledWith(false, 'top');
    expect(props.onOpacityChange).toHaveBeenCalledWith(0.8, 'top');
    expect(props.onRecalibrate).toHaveBeenCalledWith('top');
  });

  it('requires confirmation before deleting and reports the side after confirmation', () => {
    const props = cardProps('bottom');
    const container = render(createElement(PhotoOverlayCard, props));

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-remove-bottom"]')?.click());
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(props.onRemove).not.toHaveBeenCalled();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-remove-confirm-bottom"]')?.click());
    expect(props.onRemove).toHaveBeenCalledWith('bottom');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('disables picker, drop and controls without invoking callbacks', () => {
    const props = cardProps('top', { disabled: true });
    const container = render(createElement(PhotoOverlayCard, props));
    const file = new File(['jpeg'], 'board-photo.jpg', { type: 'image/jpeg' });

    expect(container.querySelector<HTMLInputElement>('[data-testid="photo-overlay-file-input-top"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-dropzone-top"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[data-testid="photo-overlay-visible-top"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[data-testid="photo-overlay-opacity-top"]')?.disabled).toBe(true);
    drop(container, 'top', file);

    expect(props.onImport).not.toHaveBeenCalled();
    expect(props.onRecalibrate).not.toHaveBeenCalled();
    expect(props.onRemove).not.toHaveBeenCalled();
  });

  it('shows loading and error states', () => {
    const loading = render(createElement(PhotoOverlayCard, cardProps('top', {
      status: 'loading',
      metadata: null,
      previewUrl: null,
    })));
    expect(loading.querySelector('[role="status"]')?.textContent).toContain('Vorschau wird geladen');

    const error = render(createElement(PhotoOverlayCard, cardProps('bottom', {
      status: 'error',
      error: 'Preview failed',
      metadata: null,
      previewUrl: null,
    })));
    expect(error.querySelector('[role="alert"]')?.textContent).toContain('Preview failed');
  });
});
