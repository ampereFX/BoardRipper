// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MarkerPanel } from './MarkerPanel';

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const snapshot = { markers: [] as Array<Record<string, unknown>>, runtime: {} as Record<string, { status: string; error: string | null }>, selectedMarkerId: null as string | null };
  const markerStore = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    hydrate: vi.fn(async () => {}),
    resolveIdentity: vi.fn(async (_tabId: number, index: number) => ({
      tabId: 1,
      fileKey: 'board.bvr:100:1',
      subboardKey: `sub-${index}`,
      bounds: { minX: index * 1000, minY: 0, maxX: (index + 1) * 1000, maxY: 1000 },
    })),
    getForTab: vi.fn((_tabId: number, fileKey: string, subboardKey?: string) => snapshot.markers.filter((marker) =>
      marker.fileKey === fileKey && (subboardKey === undefined || marker.subboardKey === subboardKey),
    )),
    selectMarker: vi.fn((id: string | null) => { snapshot.selectedMarkerId = id; listeners.forEach((listener) => listener()); }),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const marker = snapshot.markers.find((entry) => entry.id === id)!;
      Object.assign(marker, patch, { updatedAt: Date.now() });
      listeners.forEach((listener) => listener());
      return marker;
    }),
    remove: vi.fn(async (id: string) => {
      const index = snapshot.markers.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      const [removed] = snapshot.markers.splice(index, 1);
      listeners.forEach((listener) => listener());
      return removed;
    }),
    restore: vi.fn(async (marker: Record<string, unknown>) => { snapshot.markers.push(marker); }),
    retry: vi.fn(async () => {}),
  };
  return { markerStore, snapshot, listeners, addToast: vi.fn(), openMarkerPanel: vi.fn(), navigateToMarker: vi.fn() };
});

vi.mock('../markers/marker-store', () => ({ markerStore: mocks.markerStore }));
vi.mock('../store/board-store', () => ({ boardStore: { addToast: mocks.addToast } }));
vi.mock('../markers/board-identity', () => ({
  relativeToBoardPoint: (board: { bounds: { minX: number; minY: number; maxX: number; maxY: number } }, point: { x: number; y: number }) => ({
    x: board.bounds.minX + point.x * (board.bounds.maxX - board.bounds.minX),
    y: board.bounds.minY + point.y * (board.bounds.maxY - board.bounds.minY),
  }),
}));
vi.mock('./board-viewer-bridge', () => ({
  openMarkerPanel: mocks.openMarkerPanel,
  navigateToMarker: mocks.navigateToMarker,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

function marker(id: string, values: Record<string, unknown> = {}) {
  return {
    id,
    fileKey: 'board.bvr:100:1',
    subboardKey: 'sub-0',
    x: 0.25,
    y: 0.5,
    side: 'top',
    name: id,
    net: null,
    note: '',
    color: '#e45757',
    context: null,
    createdAt: id === 'older' ? 1 : 2,
    updatedAt: 2,
    ...values,
  };
}

function renderPanel(props: Partial<{ focusMarkerId: string | null; subboardCount: number }> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(createElement(MarkerPanel, {
    tabId: 1,
    subboardCount: 1,
    focusMarkerId: null,
    onFocusHandled: vi.fn(),
    ...props,
  })));
  return container;
}

beforeEach(() => {
  mocks.snapshot.markers = [];
  mocks.snapshot.runtime = {};
  mocks.snapshot.selectedMarkerId = null;
  mocks.listeners.clear();
  mocks.markerStore.hydrate.mockClear();
  mocks.markerStore.resolveIdentity.mockClear();
  mocks.markerStore.getForTab.mockClear();
  mocks.markerStore.selectMarker.mockClear();
  mocks.markerStore.update.mockClear();
  mocks.markerStore.remove.mockClear();
  mocks.markerStore.restore.mockClear();
  mocks.addToast.mockClear();
  mocks.openMarkerPanel.mockClear();
  mocks.navigateToMarker.mockClear();
});

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('MarkerPanel', () => {
  it('lists markers newest first across subboards with location and side', async () => {
    mocks.snapshot.markers = [
      marker('older'),
      marker('newer', { subboardKey: 'sub-1', x: 0.5, side: 'both' }),
    ];
    const container = renderPanel({ subboardCount: 2 });
    await act(async () => { await Promise.resolve(); });

    const rows = [...container.querySelectorAll<HTMLElement>('.marker-row')];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('newer'),
      expect.stringContaining('older'),
    ]);
    expect(rows[0].textContent).toContain('Board 2 · 1500, 500 mil');
    expect(rows[0].textContent).toContain('Both sides');
  });

  it('filters by net and note, and focuses the note only for the requested marker', async () => {
    mocks.snapshot.markers = [
      marker('first', { net: 'PP_VCC', note: 'replace connector' }),
      marker('second', { net: 'GND', note: 'inspect diode' }),
    ];
    mocks.snapshot.selectedMarkerId = 'second';
    const onFocusHandled = vi.fn();
    const container = renderPanel({ focusMarkerId: 'second' });
    await act(async () => { await Promise.resolve(); });

    expect(document.activeElement).toBe(container.querySelector('[data-testid="marker-note-second"]'));
    expect(onFocusHandled).not.toHaveBeenCalled();
    const search = container.querySelector<HTMLInputElement>('[data-testid="marker-search"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'gnd');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll('.marker-row')).toHaveLength(1);
    expect(container.querySelector('[data-testid="marker-row-second"]')).not.toBeNull();
  });

  it('autosaves only the edited field and navigates to the selected board position', async () => {
    mocks.snapshot.markers = [marker('first')];
    mocks.snapshot.selectedMarkerId = 'first';
    const container = renderPanel();
    await act(async () => { await Promise.resolve(); });

    const note = container.querySelector<HTMLTextAreaElement>('[data-testid="marker-note-first"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'check rail');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(mocks.markerStore.update).toHaveBeenCalledWith('first', { note: 'check rail' });

    act(() => container.querySelector<HTMLButtonElement>('.marker-row__navigate')?.click());
    expect(mocks.markerStore.selectMarker).toHaveBeenCalledWith('first');
    expect(mocks.openMarkerPanel).toHaveBeenCalledWith(1, 'first');
    expect(mocks.navigateToMarker).toHaveBeenCalledWith(1, 'first');
  });

  it('offers Undo only after delete succeeds', async () => {
    mocks.snapshot.markers = [marker('first')];
    mocks.snapshot.selectedMarkerId = 'first';
    const container = renderPanel();
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Delete marker first"]')?.click();
      await Promise.resolve();
    });

    const toast = mocks.addToast.mock.calls.at(-1);
    expect(toast?.[0]).toContain('deleted');
    expect(toast?.[2]?.label).toBe('Undo');
    await act(async () => { await toast?.[2]?.run(); });
    expect(mocks.markerStore.restore).toHaveBeenCalledWith(expect.objectContaining({ id: 'first' }));
  });
});
