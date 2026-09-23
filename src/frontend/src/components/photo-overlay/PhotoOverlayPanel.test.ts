// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OverlaySide } from '../../photo-overlay/types';
import { PhotoOverlayPanel } from './PhotoOverlayPanel';
import type { PhotoOverlayCardProps, PhotoOverlaySubboardOption } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function card(side: OverlaySide): PhotoOverlayCardProps {
  return {
    side,
    status: 'empty',
    metadata: null,
    previewUrl: null,
    error: null,
    visible: true,
    opacity: 0.5,
    onImport: vi.fn(),
    onVisibilityChange: vi.fn(),
    onOpacityChange: vi.fn(),
    onRecalibrate: vi.fn(),
    onRemove: vi.fn(),
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

const subboards: readonly PhotoOverlaySubboardOption[] = [
  { key: 'main', label: 'Main board', description: 'AP' },
  { key: 'daughter', label: 'Daughter board', description: 'BB' },
];

function panelProps(overrides: Partial<Parameters<typeof PhotoOverlayPanel>[0]> = {}) {
  return {
    subboards,
    selectedSubboardKey: 'main',
    onSubboardChange: vi.fn(),
    cards: { top: card('top'), bottom: card('bottom') },
    ...overrides,
  };
}

describe('PhotoOverlayPanel', () => {
  it('renders both side cards and the physical subboard choices', () => {
    const container = render(createElement(PhotoOverlayPanel, panelProps()));

    expect(container.querySelector('[data-testid="photo-overlay-card-top"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="photo-overlay-card-bottom"]')).not.toBeNull();
    expect(container.querySelectorAll('#photo-overlay-subboard option')).toHaveLength(3);
    expect(container.querySelector('h2')?.textContent).toBe('Fotos');
    expect(container.querySelector('label[for="photo-overlay-subboard"]')?.textContent).toBe('Physisches Einzelboard');
    expect(container.querySelector('#photo-overlay-subboard option[value=""]')?.textContent)
      .toBe('Physisches Einzelboard auswählen');
    expect(container.querySelector('[data-testid="photo-overlay-card-top"] h3')?.textContent).toBe('Oberseite');
    expect(container.querySelector('[data-testid="photo-overlay-card-bottom"] h3')?.textContent).toBe('Unterseite');
    expect(container.textContent).toContain('Main board — AP');
    expect(container.textContent).toContain('Daughter board — BB');
  });

  it('reports a changed physical subboard', () => {
    const props = panelProps();
    const container = render(createElement(PhotoOverlayPanel, props));
    const select = container.querySelector<HTMLSelectElement>('[data-testid="photo-overlay-subboard-select"]')!;
    select.value = 'daughter';
    act(() => select.dispatchEvent(new Event('change', { bubbles: true })));

    expect(props.onSubboardChange).toHaveBeenCalledWith('daughter');
  });

  it('shows an offline notice and disables the panel controls', () => {
    const container = render(createElement(PhotoOverlayPanel, panelProps({ mode: 'offline' })));

    expect(container.querySelector('[data-testid="photo-overlay-mode-notice"]')?.textContent).toContain('Offline-Modus');
    expect(container.querySelector<HTMLSelectElement>('[data-testid="photo-overlay-subboard-select"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-dropzone-top"]')?.disabled).toBe(true);
  });

  it('shows the Lite notice and handles an unavailable board list', () => {
    const lite = render(createElement(PhotoOverlayPanel, panelProps({ mode: 'lite' })));
    expect(lite.querySelector('[data-testid="photo-overlay-mode-notice"]')?.textContent).toContain('Lite-Modus');

    const empty = render(createElement(PhotoOverlayPanel, panelProps({ subboards: [], selectedSubboardKey: null })));
    expect(empty.querySelector('[data-testid="photo-overlay-no-subboards"]')?.textContent)
      .toContain('keine physischen Einzelboards');
    expect(empty.querySelector<HTMLButtonElement>('[data-testid="photo-overlay-dropzone-top"]')?.disabled).toBe(true);
  });

  it('honours the explicit disabled prop', () => {
    const container = render(createElement(PhotoOverlayPanel, panelProps({ disabled: true })));

    expect(container.querySelector('[data-testid="photo-overlay-panel"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector<HTMLSelectElement>('[data-testid="photo-overlay-subboard-select"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[data-testid="photo-overlay-file-input-bottom"]')?.disabled).toBe(true);
  });
});
