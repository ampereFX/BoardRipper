// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useBoardStore } from '../hooks/useBoardStore';
import { BoardSidebar } from './BoardSidebar';

vi.mock('../hooks/useBoardStore', () => ({
  useBoardStore: vi.fn(),
}));

vi.mock('../store/board-store', () => ({
  boardStore: new Proxy({}, { get: () => vi.fn() }),
  ghostPairSig: vi.fn(),
  bomClusterSig: vi.fn(),
}));

vi.mock('../store/obd-store', () => ({
  obdBoardNumberFor: vi.fn(),
}));

vi.mock('./photo-overlay/PhotoOverlayIntegration', () => ({
  PhotoOverlayIntegration: () => createElement(
    'div',
    { 'data-testid': 'photo-overlay-integration' },
    'Foto-Integrationsbereich',
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

beforeEach(() => {
  const storage = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  } as unknown as Storage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  vi.mocked(useBoardStore).mockReturnValue({
    tabs: [{ id: 1, board: null, layerStates: [] }],
  } as unknown as ReturnType<typeof useBoardStore>);
});

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

function renderSidebar(props: Partial<ComponentProps<typeof BoardSidebar>> = {}): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(createElement(BoardSidebar, { visible: true, tabId: 1, ...props }));
  });
  return container;
}

describe('BoardSidebar photo tab integration', () => {
  it('renders Fotos and switches only the visible tab content on click', () => {
    const container = renderSidebar();

    const photosTab = container.querySelector<HTMLButtonElement>('[data-board-tab="photos"]');
    expect(photosTab?.getAttribute('aria-label')).toBe('Fotos');
    expect(photosTab?.getAttribute('data-title')).toBe('Fotos');
    expect(container.querySelector('.panel-empty')?.textContent).toBe('No board loaded');

    act(() => photosTab?.click());

    expect(container.querySelector('[data-testid="photo-overlay-integration"]')?.textContent)
      .toBe('Foto-Integrationsbereich');
    expect(container.querySelector('.panel-empty')).toBeNull();
    expect(container.querySelector('[data-board-tab="photos"]')?.classList.contains('active')).toBe(true);
  });

  it('opens Fotos from requestedTab and reports that the request was applied', () => {
    const onTabApplied = vi.fn();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    const container = renderSidebar({ requestedTab: 'photos', onTabApplied });

    expect(container.querySelector('[data-testid="photo-overlay-integration"]')).not.toBeNull();
    expect(container.querySelector('[data-board-tab="photos"]')?.classList.contains('active')).toBe(true);
    expect(onTabApplied).toHaveBeenCalledTimes(1);
  });
});
