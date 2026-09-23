import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { boardStore } from '../../store/board-store';
import { buildOverlayUrl, deleteBoardPhotoOverlay } from '../../photo-overlay/api-client';
import { boardLifecycleController } from '../../photo-overlay/board-lifecycle-controller';
import { photoOverlayStore } from '../../photo-overlay/overlay-store';
import {
  loadOverlayDisplayPreferences,
  setOverlayDisplayPreferences,
} from '../../photo-overlay/view-preferences';
import type { OverlaySide, OverlayDisplayPreferences } from '../../photo-overlay/types';
import type { OverlaySubboardLifecycle, OverlayTabLifecycle } from '../../photo-overlay/board-lifecycle-controller';
import type { PhotoOverlayCardProps, PhotoOverlayPanelProps, PhotoOverlaySubboardOption } from './types';

export interface UsePhotoOverlayPanelOptions {
  onBeginImport?: (file: File, side: OverlaySide, boardKey: string, subboardIndex: number) => void;
  onBeginRecalibration?: (side: OverlaySide, boardKey: string, subboardIndex: number) => void;
}

interface SelectedSubboard {
  index: number;
  lifecycle: OverlaySubboardLifecycle;
}

interface OperationState {
  loading: boolean;
  error: string | null;
}

const SIDES = ['top', 'bottom'] as const;
const DEFAULT_PREFERENCES: OverlayDisplayPreferences = { visible: true, opacity: 0.5 };
const EMPTY_OPERATION: OperationState = { loading: false, error: null };

// BoardLifecycleController reads the selected board index from boardStore and
// PhotoOverlayStore owns the asset state. A shared version counter keeps the
// useSyncExternalStore snapshot primitive and stable.
let storeVersion = 0;
const storeListeners = new Set<() => void>();
let storeSubscriptionsReady = false;

function notifyStoreListeners(): void {
  storeVersion += 1;
  for (const listener of storeListeners) listener();
}

function ensureStoreSubscriptions(): void {
  if (storeSubscriptionsReady) return;
  storeSubscriptionsReady = true;
  boardStore.subscribe(notifyStoreListeners);
  photoOverlayStore.subscribe(notifyStoreListeners);
}

function subscribeToOverlayStores(listener: () => void): () => void {
  ensureStoreSubscriptions();
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

function getOverlayStoreVersion(): number {
  ensureStoreSubscriptions();
  return storeVersion;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyPreferences(): Record<OverlaySide, OverlayDisplayPreferences> {
  return {
    top: { ...DEFAULT_PREFERENCES },
    bottom: { ...DEFAULT_PREFERENCES },
  };
}

function emptyOperations(): Record<OverlaySide, OperationState> {
  return {
    top: { ...EMPTY_OPERATION },
    bottom: { ...EMPTY_OPERATION },
  };
}

function subboardOptions(lifecycle: OverlayTabLifecycle | null): readonly PhotoOverlaySubboardOption[] {
  if (!lifecycle) return [];
  return lifecycle.subboards.map((subboard, index) => ({
    key: subboard.boardKey ?? `pending-subboard-${index}`,
    label: subboard.name?.trim() || `Subboard ${index + 1}`,
    disabled: subboard.boardKey === null,
  }));
}

function selectedSubboardFor(
  lifecycle: OverlayTabLifecycle | null,
  selectedKey: string | null,
): SelectedSubboard | null {
  if (!lifecycle) return null;

  const selectedIndex = lifecycle.subboards.findIndex((subboard, index) => {
    const key = subboard.boardKey ?? `pending-subboard-${index}`;
    return key === selectedKey;
  });
  if (selectedIndex >= 0) {
    const selected = lifecycle.subboards[selectedIndex];
    if (selected) return { index: selectedIndex, lifecycle: selected };
  }

  const preferredIndex = lifecycle.activeSubboardIndex ?? 0;
  const fallback = lifecycle.subboards[preferredIndex] ?? lifecycle.subboards[0];
  return fallback
    ? { index: lifecycle.subboards.indexOf(fallback), lifecycle: fallback }
    : null;
}

function cardStatus(
  side: OverlaySide,
  selected: SelectedSubboard | null,
  operations: Record<OverlaySide, OperationState>,
): PhotoOverlayCardProps['status'] {
  if (operations[side].loading) return 'loading';
  if (operations[side].error) return 'error';
  const lifecycleSide = selected?.lifecycle.sides?.[side];
  if (!lifecycleSide) return 'empty';
  if (lifecycleSide.status === 'loading') return 'loading';
  if (lifecycleSide.status === 'error') return 'error';
  return lifecycleSide.hasMetadata ? 'ready' : 'empty';
}

export function usePhotoOverlayPanel(
  tabId: number,
  options: UsePhotoOverlayPanelOptions = {},
): PhotoOverlayPanelProps {
  useSyncExternalStore(subscribeToOverlayStores, getOverlayStoreVersion, getOverlayStoreVersion);

  const lifecycle = boardLifecycleController.getLifecycle(tabId);
  const optionsForLifecycle = useMemo(() => subboardOptions(lifecycle), [lifecycle]);
  const [selection, setSelection] = useState<{ tabId: number; key: string | null }>({ tabId, key: null });
  const [preferences, setPreferences] = useState<Record<OverlaySide, OverlayDisplayPreferences>>(
    emptyPreferences,
  );
  const [operations, setOperations] = useState<Record<OverlaySide, OperationState>>(emptyOperations);
  const preferenceWriteVersions = useRef<Record<OverlaySide, number>>({ top: 0, bottom: 0 });
  const contextGeneration = useRef(0);
  const mounted = useRef(true);

  const selectionKey = selection.tabId === tabId ? selection.key : null;
  const selected = selectedSubboardFor(lifecycle, selectionKey);
  const selectedKey = selected?.lifecycle.boardKey ?? null;
  const contextId = `${tabId}|${selectedKey ?? ''}`;
  const { onBeginImport, onBeginRecalibration } = options;
  const interactionsDisabled = lifecycle?.status !== 'ready' || !selectedKey;

  useEffect(() => {
    setSelection((current) => {
      if (current.tabId === tabId && current.key === (selected?.lifecycle.boardKey ?? null)) return current;
      return { tabId, key: selected?.lifecycle.boardKey ?? null };
    });
  }, [selected, tabId]);

  useEffect(() => {
    mounted.current = true;
    const generation = ++contextGeneration.current;
    preferenceWriteVersions.current = { top: 0, bottom: 0 };
    setPreferences(emptyPreferences());
    setOperations(emptyOperations());

    if (!selectedKey) return () => undefined;

    let cancelled = false;
    for (const side of SIDES) {
      const writeVersion = preferenceWriteVersions.current[side];
      void loadOverlayDisplayPreferences(selectedKey, side)
        .then((loaded) => {
          if (
            cancelled
            || !mounted.current
            || contextGeneration.current !== generation
            || preferenceWriteVersions.current[side] !== writeVersion
          ) return;
          setPreferences((current) => ({ ...current, [side]: loaded }));
        })
        .catch(() => {
          // Missing or unavailable local preferences use the already-rendered defaults.
        });
    }

    return () => {
      cancelled = true;
    };
  }, [contextId, selectedKey]);

  useEffect(() => () => {
    mounted.current = false;
    contextGeneration.current += 1;
  }, []);

  const handleSubboardChange = useCallback((subboardKey: string): void => {
    if (interactionsDisabled) return;
    const option = lifecycle?.subboards.find((subboard, index) => (
      (subboard.boardKey ?? `pending-subboard-${index}`) === subboardKey
    ));
    if (!option?.boardKey) return;
    setSelection({ tabId, key: option.boardKey });
  }, [interactionsDisabled, lifecycle, tabId]);

  const handleImport = useCallback((file: File, side: OverlaySide): void => {
    if (interactionsDisabled || !selected) return;
    onBeginImport?.(file, side, selectedKey, selected.index);
  }, [interactionsDisabled, onBeginImport, selected, selectedKey]);

  const handleRecalibrate = useCallback((side: OverlaySide): void => {
    if (interactionsDisabled || !selected) return;
    onBeginRecalibration?.(side, selectedKey, selected.index);
  }, [interactionsDisabled, onBeginRecalibration, selected, selectedKey]);

  const handleVisibilityChange = useCallback((visible: boolean, side: OverlaySide): void => {
    if (interactionsDisabled) return;
    preferenceWriteVersions.current[side] += 1;
    setPreferences((current) => ({ ...current, [side]: { ...current[side], visible } }));
    void setOverlayDisplayPreferences(selectedKey, side, { visible }).catch(() => undefined);
  }, [interactionsDisabled, selectedKey]);

  const handleOpacityChange = useCallback((opacity: number, side: OverlaySide): void => {
    if (interactionsDisabled) return;
    preferenceWriteVersions.current[side] += 1;
    setPreferences((current) => ({ ...current, [side]: { ...current[side], opacity } }));
    void setOverlayDisplayPreferences(selectedKey, side, { opacity }).catch(() => undefined);
  }, [interactionsDisabled, selectedKey]);

  const handleRemove = useCallback(async (side: OverlaySide): Promise<void> => {
    if (interactionsDisabled || !selected || operations[side].loading) return;
    const generation = contextGeneration.current;
    setOperations((current) => ({ ...current, [side]: { loading: true, error: null } }));

    try {
      await deleteBoardPhotoOverlay(selectedKey, side);
      if (!mounted.current || contextGeneration.current !== generation) return;
      photoOverlayStore.updateAfterDelete(selectedKey, side);
      setOperations((current) => ({ ...current, [side]: { ...EMPTY_OPERATION } }));
    } catch (error) {
      if (!mounted.current || contextGeneration.current !== generation) return;
      setOperations((current) => ({
        ...current,
        [side]: { loading: false, error: errorMessage(error) },
      }));
    }
  }, [interactionsDisabled, operations, selected, selectedKey]);

  const cards = useMemo((): Record<OverlaySide, PhotoOverlayCardProps> => {
    const makeCard = (side: OverlaySide): PhotoOverlayCardProps => {
      const lifecycleSide = selected?.lifecycle.sides?.[side];
      const storeSide = selectedKey ? photoOverlayStore.getBoardState(selectedKey).sides[side] : null;
      const operation = operations[side];
      const status = cardStatus(side, selected, operations);
      const metadata = storeSide?.metadata ?? null;
      return {
        side,
        status,
        metadata,
        previewUrl: metadata && selectedKey ? buildOverlayUrl(selectedKey, side, 'render') : null,
        error: operation.error ?? lifecycleSide?.error ?? storeSide?.error?.message ?? null,
        visible: preferences[side].visible,
        opacity: preferences[side].opacity,
        disabled: interactionsDisabled || selected?.lifecycle.boardKey === null,
        onImport: handleImport,
        onVisibilityChange: handleVisibilityChange,
        onOpacityChange: handleOpacityChange,
        onRecalibrate: handleRecalibrate,
        onRemove: handleRemove,
      };
    };

    return { top: makeCard('top'), bottom: makeCard('bottom') };
  }, [handleImport, handleOpacityChange, handleRecalibrate, handleRemove, handleVisibilityChange, interactionsDisabled, operations, preferences, selected, selectedKey]);

  const mode: PhotoOverlayPanelProps['mode'] = lifecycle?.reason === 'offline'
    ? 'offline'
    : lifecycle?.reason === 'lite'
      ? 'lite'
      : 'online';
  const disabled = lifecycle === null || lifecycle.status === 'disabled' || lifecycle.status === 'pending';

  return {
    subboards: optionsForLifecycle,
    selectedSubboardKey: selectedKey,
    onSubboardChange: handleSubboardChange,
    cards,
    mode,
    disabled,
  };
}
