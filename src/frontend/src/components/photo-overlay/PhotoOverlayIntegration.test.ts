// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PhotoOverlayPanelProps } from './types';
import type { CalibrationDialogResult } from './CalibrationDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  panelProps: null as PhotoOverlayPanelProps | null,
  dialogProps: null as {
    mode?: 'import' | 'recalibrate';
    onSave: (result: CalibrationDialogResult) => void;
    onCancel: () => void;
  } | null,
  setSelectedBoardIndex: vi.fn(),
  putOverlay: vi.fn<(...args: unknown[]) => Promise<void>>(),
  putCalibration: vi.fn<(...args: unknown[]) => Promise<void>>(),
  putMask: vi.fn<(...args: unknown[]) => Promise<void>>(),
  loadAsset: vi.fn<(...args: unknown[]) => Promise<void>>(),
  setPreferences: vi.fn<(...args: unknown[]) => Promise<void>>(),
  getBoardState: vi.fn(),
  fetch: vi.fn(),
  mode: 'online' as 'online' | 'lite' | 'offline',
  hookOptions: null as {
    onBeginImport?: (file: File, side: 'top' | 'bottom', boardKey: string, subboardIndex: number) => void;
    onBeginRecalibration?: (side: 'top' | 'bottom', boardKey: string, subboardIndex: number) => void;
  } | null,
}));

vi.mock('../../store/board-store', () => ({
  boardStore: {
    getTab: vi.fn(() => ({
      board: {
        format: 'TEST',
        outline: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }],
        parts: [], nails: [], nets: new Map(),
        bounds: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
      },
      foldMode: 'suggested', swappedBoards: new Set(),
    })),
    setSelectedBoardIndex: mocks.setSelectedBoardIndex,
  },
}));

vi.mock('../../photo-overlay/api-client', () => ({
  buildOverlayUrl: vi.fn(() => '/source'),
  putBoardPhotoOverlay: mocks.putOverlay,
  putBoardPhotoCalibration: mocks.putCalibration,
  putBoardPhotoMask: mocks.putMask,
}));

vi.mock('../../photo-overlay/overlay-store', () => ({
  photoOverlayStore: {
    getBoardState: mocks.getBoardState,
    loadAsset: mocks.loadAsset,
  },
}));

vi.mock('../../photo-overlay/view-preferences', () => ({
  setOverlayDisplayPreferences: mocks.setPreferences,
}));

vi.mock('./use-photo-overlay-panel', () => ({
  usePhotoOverlayPanel: vi.fn((_: number, options: typeof mocks.hookOptions) => {
    mocks.hookOptions = options;
    return ({
    subboards: [{ key: 'board-0', label: 'Board 1' }],
    selectedSubboardKey: 'board-0',
    onSubboardChange: vi.fn(),
    cards: {
      top: { side: 'top', status: 'empty', metadata: null, previewUrl: null, error: null, visible: true, opacity: 0.5, onImport: (file: File, side: 'top' | 'bottom') => options?.onBeginImport?.(file, side, 'board-0', 0), onVisibilityChange: vi.fn(), onOpacityChange: vi.fn(), onRecalibrate: (side: 'top' | 'bottom') => options?.onBeginRecalibration?.(side, 'board-0', 0), onRemove: vi.fn() },
      bottom: { side: 'bottom', status: 'empty', metadata: null, previewUrl: null, error: null, visible: true, opacity: 0.5, onImport: vi.fn(), onVisibilityChange: vi.fn(), onOpacityChange: vi.fn(), onRecalibrate: vi.fn(), onRemove: vi.fn() },
    },
    mode: mocks.mode,
    disabled: false,
    });
  }),
}));

vi.mock('./PhotoOverlayPanel', () => ({
  PhotoOverlayPanel: (props: PhotoOverlayPanelProps) => {
    mocks.panelProps = props;
    return createElement('div', { 'data-testid': 'panel' },
      createElement('button', { onClick: () => props.onSubboardChange('board-0') }, 'select'),
      createElement('button', { onClick: () => props.cards.top.onImport(new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }), 'top') }, 'import'),
      createElement('button', { onClick: () => props.cards.top.onRecalibrate('top') }, 'recalibrate'),
      createElement('span', { 'data-testid': 'mode' }, props.mode),
    );
  },
}));

vi.mock('./CalibrationDialog', () => ({
  CalibrationDialog: (props: { mode?: 'import' | 'recalibrate'; onSave: (result: CalibrationDialogResult) => void; onCancel: () => void }) => {
    mocks.dialogProps = props;
    const calibration = { version: 1 as const, points: [] };
    return createElement('div', { 'data-testid': 'dialog' },
      createElement('button', { onClick: () => props.onSave(props.mode === 'recalibrate'
        ? { mode: 'recalibrate', calibration, manualMask: null }
        : { mode: 'import', photoBlob: new Blob(['normalized'], { type: 'image/jpeg' }), calibration, manualMask: null }) }, 'save'),
      createElement('button', { onClick: props.onCancel }, 'cancel'),
    );
  },
}));

import { PhotoOverlayIntegration } from './PhotoOverlayIntegration';

const board = {
  format: 'TEST',
  outline: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }],
  parts: [], nails: [], nets: new Map(),
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.getBoardState.mockImplementation(() => ({
    mask: null,
    sides: {
      top: { metadata: null, calibration: null },
      bottom: { metadata: null, calibration: null },
    },
  }));
  mocks.fetch.mockReset();
  vi.stubGlobal('fetch', mocks.fetch);
});

function render(): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(PhotoOverlayIntegration, { tabId: 1, board })));
}

function click(label: string): void {
  const button = [...(container?.querySelectorAll('button') ?? [])]
    .find((candidate) => candidate.textContent === label) as HTMLButtonElement | undefined;
  if (!button) throw new Error(`Button ${label} not found`);
  act(() => button.click());
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  mocks.panelProps = null;
  mocks.dialogProps = null;
  mocks.setSelectedBoardIndex.mockReset();
  mocks.putOverlay.mockReset();
  mocks.putCalibration.mockReset();
  mocks.putMask.mockReset();
  mocks.loadAsset.mockReset();
  mocks.setPreferences.mockReset();
  mocks.getBoardState.mockReset();
  mocks.mode = 'online';
  mocks.hookOptions = null;
  vi.unstubAllGlobals();
});

describe('PhotoOverlayIntegration', () => {
  it('verknüpft Auswahl und Importdialog mit dem Overlay-PUT und lädt danach den Store neu', async () => {
    render();
    click('select');
    expect(mocks.setSelectedBoardIndex).not.toHaveBeenCalled();
    click('import');
    expect(container?.querySelector('[data-testid="dialog"]')).not.toBeNull();

    mocks.putOverlay.mockResolvedValueOnce(undefined);
    await act(async () => click('save'));

    expect(mocks.putOverlay).toHaveBeenCalledWith('board-0', 'top', expect.any(Blob), { version: 1, points: [] });
    expect(mocks.putCalibration).not.toHaveBeenCalled();
    expect(mocks.loadAsset).toHaveBeenCalledWith('board-0');
    expect(mocks.setPreferences).toHaveBeenCalledWith('board-0', 'top', { visible: true, opacity: 0.5 });
    expect(container?.querySelector('[data-testid="dialog"]')).toBeNull();
  });

  it('lädt beim Rekalibrieren das Source-Bild und verwendet ausschließlich den Calibration-PUT', async () => {
    const state = {
      mask: null,
      sides: {
        top: { metadata: { id: 'photo', mimeType: 'image/jpeg', widthPx: 10, heightPx: 10 }, calibration: { version: 1, points: [] } },
        bottom: { metadata: null, calibration: null },
      },
    };
    mocks.getBoardState.mockReturnValue(state);
    mocks.fetch.mockResolvedValueOnce(new Response(new Blob(['source'], { type: 'image/jpeg' }), { status: 200 }));
    render();
    click('recalibrate');
    await act(async () => { await Promise.resolve(); });
    expect(mocks.fetch).toHaveBeenCalledWith('/source', { credentials: 'same-origin' });
    expect(container?.querySelector('[data-testid="dialog"]')).not.toBeNull();

    mocks.putCalibration.mockResolvedValueOnce(undefined);
    await act(async () => click('save'));
    expect(mocks.putCalibration).toHaveBeenCalledWith('board-0', 'top', { version: 1, points: [] });
    expect(mocks.putOverlay).not.toHaveBeenCalled();
  });

  it('verwirft einen begonnenen Import bei Abbruch ohne API-Aufruf', () => {
    render();
    click('import');
    click('cancel');
    expect(mocks.putOverlay).not.toHaveBeenCalled();
    expect(mocks.putCalibration).not.toHaveBeenCalled();
    expect(container?.querySelector('[data-testid="dialog"]')).toBeNull();
  });

  it('reicht Lite-/Offline-Hinweise des bestehenden Panels unverändert durch', () => {
    mocks.mode = 'lite';
    render();
    expect(container?.querySelector('[data-testid="mode"]')?.textContent).toBe('lite');
  });
});
