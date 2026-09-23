// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OverlayTabLifecycle } from '../../photo-overlay/board-lifecycle-controller';
import type { OverlayBoardState } from '../../photo-overlay/overlay-store';
import type { OverlaySide } from '../../photo-overlay/types';
import type { PhotoOverlayPanelProps } from './types';
import { usePhotoOverlayPanel } from './use-photo-overlay-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const boardListeners = new Set<() => void>();
  const overlayListeners = new Set<() => void>();
  const states = new Map<string, OverlayBoardState>();
  return {
    boardListeners,
    overlayListeners,
    states,
    lifecycle: null as OverlayTabLifecycle | null,
    buildOverlayUrl: vi.fn((boardKey: string, side: OverlaySide, variant: string) => (
      `/preview/${boardKey}/${side}/${variant}`
    )),
    deleteBoardPhotoOverlay: vi.fn<(...args: unknown[]) => Promise<void>>(),
    loadOverlayDisplayPreferences: vi.fn(),
    setOverlayDisplayPreferences: vi.fn<(...args: unknown[]) => Promise<void>>(),
    updateAfterDelete: vi.fn(),
  };
});

vi.mock('../../store/board-store', () => ({
  boardStore: {
    subscribe(listener: () => void) {
      mocks.boardListeners.add(listener);
      return () => mocks.boardListeners.delete(listener);
    },
  },
}));

vi.mock('../../photo-overlay/board-lifecycle-controller', () => ({
  boardLifecycleController: {
    getLifecycle: vi.fn(() => mocks.lifecycle),
  },
}));

vi.mock('../../photo-overlay/overlay-store', () => ({
  photoOverlayStore: {
    subscribe(listener: () => void) {
      mocks.overlayListeners.add(listener);
      return () => mocks.overlayListeners.delete(listener);
    },
    getBoardState(boardKey: string) {
      return mocks.states.get(boardKey) ?? emptyBoardState();
    },
    updateAfterDelete: mocks.updateAfterDelete,
  },
}));

vi.mock('../../photo-overlay/api-client', () => ({
  buildOverlayUrl: mocks.buildOverlayUrl,
  deleteBoardPhotoOverlay: mocks.deleteBoardPhotoOverlay,
}));

vi.mock('../../photo-overlay/view-preferences', () => ({
  loadOverlayDisplayPreferences: mocks.loadOverlayDisplayPreferences,
  setOverlayDisplayPreferences: mocks.setOverlayDisplayPreferences,
}));

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];
let latest: PhotoOverlayPanelProps | null = null;

function makeLifecycle(
  activeSubboardIndex: number | null,
  reason: OverlayTabLifecycle['reason'] = null,
  status: OverlayTabLifecycle['status'] = 'ready',
): OverlayTabLifecycle {
  const sides = {
    top: { status: 'ready' as const, hasMetadata: true, renderImageStatus: 'idle' as const, error: null },
    bottom: { status: 'ready' as const, hasMetadata: true, renderImageStatus: 'idle' as const, error: null },
  };
  return {
    tabId: 7,
    status,
    reason,
    activeSubboardIndex,
    subboards: [
      { boardKey: 'board-a', packIndex: 0, name: 'AP', sides },
      { boardKey: 'board-b', packIndex: 1, name: 'BB', sides },
    ],
  };
}

function emptyBoardState(): OverlayBoardState {
  return {
    mask: null,
    sides: {
      top: {
        status: 'ready', metadata: null, calibration: null, renderImage: null,
        renderImageStatus: 'idle', error: null,
      },
      bottom: {
        status: 'ready', metadata: null, calibration: null, renderImage: null,
        renderImageStatus: 'idle', error: null,
      },
    },
  };
}

function assetState(): OverlayBoardState {
  const state = emptyBoardState();
  state.sides.top.metadata = { id: 'top-id', mimeType: 'image/jpeg', widthPx: 100, heightPx: 80 };
  state.sides.bottom.metadata = { id: 'bottom-id', mimeType: 'image/png', widthPx: 90, heightPx: 70 };
  return state;
}

function emitStores(): void {
  for (const listener of mocks.boardListeners) listener();
  for (const listener of mocks.overlayListeners) listener();
}

function Harness({ tabId = 7 }: { tabId?: number }): ReactElement {
  const panel = usePhotoOverlayPanel(tabId, {
    onBeginImport: importCallback,
    onBeginRecalibration: recalibrationCallback,
  });
  useEffect(() => {
    latest = panel;
  }, [panel]);
  return createElement('div');
}

const importCallback = vi.fn();
const recalibrationCallback = vi.fn();

async function renderHook(tabId = 7): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(createElement(Harness, { tabId }));
    await Promise.resolve();
  });
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  latest = null;
  mocks.lifecycle = null;
  mocks.states.clear();
  importCallback.mockReset();
  recalibrationCallback.mockReset();
  mocks.buildOverlayUrl.mockClear();
  mocks.deleteBoardPhotoOverlay.mockReset();
  mocks.loadOverlayDisplayPreferences.mockReset();
  mocks.setOverlayDisplayPreferences.mockReset();
  mocks.updateAfterDelete.mockReset();
});

beforeEach(() => {
  mocks.loadOverlayDisplayPreferences.mockResolvedValue({ visible: true, opacity: 0.5 });
  mocks.setOverlayDisplayPreferences.mockResolvedValue(undefined);
});

describe('usePhotoOverlayPanel', () => {
  it('prefers the active subboard and keeps a manual choice across store updates', async () => {
    mocks.lifecycle = makeLifecycle(1);
    await renderHook();

    expect(latest?.selectedSubboardKey).toBe('board-b');
    expect(latest?.subboards.map((subboard) => subboard.key)).toEqual(['board-a', 'board-b']);
    expect(latest?.subboards.map((subboard) => subboard.label)).toEqual(['AP', 'BB']);

    act(() => latest?.onSubboardChange('board-a'));
    expect(latest?.selectedSubboardKey).toBe('board-a');

    mocks.lifecycle = makeLifecycle(1);
    await act(async () => {
      emitStores();
      await Promise.resolve();
    });
    expect(latest?.selectedSubboardKey).toBe('board-a');
  });

  it('maps both sides, loads preferences and builds render preview URLs', async () => {
    mocks.lifecycle = makeLifecycle(0);
    mocks.states.set('board-a', assetState());
    mocks.loadOverlayDisplayPreferences.mockImplementation(async (_key: string, side: OverlaySide) => (
      side === 'top' ? { visible: false, opacity: 0.8 } : { visible: true, opacity: 0.25 }
    ));
    await renderHook();

    await act(async () => { await Promise.resolve(); });

    expect(latest?.cards.top.metadata?.id).toBe('top-id');
    expect(latest?.cards.bottom.metadata?.id).toBe('bottom-id');
    expect(latest?.cards.top.previewUrl).toBe('/preview/board-a/top/render');
    expect(latest?.cards.bottom.previewUrl).toBe('/preview/board-a/bottom/render');
    expect(latest?.cards.top.visible).toBe(false);
    expect(latest?.cards.top.opacity).toBe(0.8);
    expect(latest?.cards.bottom.opacity).toBe(0.25);
  });

  it('passes the selected board context to import and recalibration callbacks', async () => {
    mocks.lifecycle = makeLifecycle(1);
    await renderHook();
    const file = new File(['image'], 'photo.jpg', { type: 'image/jpeg' });

    act(() => latest?.cards.top.onImport(file, 'top'));
    act(() => latest?.cards.bottom.onRecalibrate('bottom'));

    expect(importCallback).toHaveBeenCalledWith(file, 'top', 'board-b', 1);
    expect(recalibrationCallback).toHaveBeenCalledWith('bottom', 'board-b', 1);
  });

  it('updates preferences optimistically and persists both controls', async () => {
    mocks.lifecycle = makeLifecycle(0);
    await renderHook();

    act(() => latest?.cards.top.onVisibilityChange(false, 'top'));
    act(() => latest?.cards.top.onOpacityChange(0.7, 'top'));

    expect(latest?.cards.top.visible).toBe(false);
    expect(latest?.cards.top.opacity).toBe(0.7);
    expect(mocks.setOverlayDisplayPreferences).toHaveBeenNthCalledWith(1, 'board-a', 'top', { visible: false });
    expect(mocks.setOverlayDisplayPreferences).toHaveBeenNthCalledWith(2, 'board-a', 'top', { opacity: 0.7 });
  });

  it('deletes successfully and exposes a failed delete without updating the store', async () => {
    mocks.lifecycle = makeLifecycle(0);
    mocks.states.set('board-a', assetState());
    const resolveDelete = vi.fn<() => void>();
    mocks.deleteBoardPhotoOverlay.mockResolvedValueOnce(undefined);
    await renderHook();

    await act(async () => { await latest?.cards.top.onRemove('top'); });
    expect(mocks.deleteBoardPhotoOverlay).toHaveBeenCalledWith('board-a', 'top');
    expect(mocks.updateAfterDelete).toHaveBeenCalledWith('board-a', 'top');
    expect(latest?.cards.top.status).toBe('ready');
    expect(resolveDelete).not.toHaveBeenCalled();

    mocks.deleteBoardPhotoOverlay.mockRejectedValueOnce(new Error('delete failed'));
    await act(async () => { await latest?.cards.bottom.onRemove('bottom'); });
    expect(latest?.cards.bottom.status).toBe('error');
    expect(latest?.cards.bottom.error).toBe('delete failed');
    expect(mocks.updateAfterDelete).toHaveBeenCalledTimes(1);
  });

  it('ignores stale delete responses after a subboard change and after unmount', async () => {
    mocks.lifecycle = makeLifecycle(0);
    mocks.states.set('board-a', assetState());
    let resolveDelete!: () => void;
    let deleteSettled!: Promise<void>;
    mocks.deleteBoardPhotoOverlay.mockImplementation(() => new Promise<void>((resolve) => {
      resolveDelete = resolve;
      deleteSettled = new Promise<void>((settled) => {
        resolveDelete = () => {
          resolve();
          settled();
        };
      });
    }));
    await renderHook();
    act(() => { latest?.cards.top.onRemove('top'); });

    act(() => latest?.onSubboardChange('board-b'));
    await act(async () => {
      resolveDelete();
      await deleteSettled;
    });
    expect(mocks.updateAfterDelete).not.toHaveBeenCalled();

    act(() => latest?.onSubboardChange('board-a'));
    act(() => { latest?.cards.top.onRemove('top'); });
    const mountedRoot = mounted[0].root;
    act(() => mountedRoot.unmount());
    resolveDelete();
    await deleteSettled;
    expect(mocks.updateAfterDelete).not.toHaveBeenCalled();
  });

  it('takes Lite and Offline disabled state from the lifecycle', async () => {
    mocks.lifecycle = makeLifecycle(null, 'lite', 'disabled');
    await renderHook();
    expect(latest?.mode).toBe('lite');
    expect(latest?.disabled).toBe(true);

    mocks.lifecycle = makeLifecycle(null, 'offline', 'disabled');
    await act(async () => {
      emitStores();
      await Promise.resolve();
    });
    expect(latest?.mode).toBe('offline');
    expect(latest?.disabled).toBe(true);
  });
});
