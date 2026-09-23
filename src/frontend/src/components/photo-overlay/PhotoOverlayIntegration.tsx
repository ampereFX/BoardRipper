import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardData } from '../../parsers';
import { boardStore } from '../../store/board-store';
import { deriveBoardView } from '../../store/derive-board-view';
import {
  buildOverlayUrl,
  putBoardPhotoCalibration,
  putBoardPhotoMask,
  putBoardPhotoOverlay,
} from '../../photo-overlay/api-client';
import { photoOverlayStore } from '../../photo-overlay/overlay-store';
import { setOverlayDisplayPreferences } from '../../photo-overlay/view-preferences';
import type { ManualBoardMask, OverlaySide, PhotoCalibration } from '../../photo-overlay/types';
import {
  CalibrationDialog,
  type CalibrationDialogResult,
} from './CalibrationDialog';
import { PhotoOverlayPanel } from './PhotoOverlayPanel';
import { usePhotoOverlayPanel } from './use-photo-overlay-panel';

interface PhotoOverlayIntegrationProps {
  tabId: number;
  board: BoardData | null;
}

interface DialogRequest {
  mode: 'import' | 'recalibrate';
  side: OverlaySide;
  boardKey: string;
  board: BoardData;
  imageBlob: Blob | null;
  initialCalibration: PhotoCalibration | null;
  initialMask: ManualBoardMask | null;
  hadOverlay: boolean;
}

function boardForSubboard(tabId: number, index: number): BoardData | null {
  const tab = boardStore.getTab(tabId);
  if (!tab?.board) return null;
  if (tab.board.boards && tab.board.boards.length > 0) {
    return deriveBoardView(tab.board, tab.foldMode, index, tab.swappedBoards);
  }
  return tab._derivedBoard ?? tab.board;
}

function boardDimensions(board: BoardData): { width: number; height: number } {
  return {
    width: Math.max(board.bounds.maxX - board.bounds.minX, Number.EPSILON),
    height: Math.max(board.bounds.maxY - board.bounds.minY, Number.EPSILON),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function loadSourceImage(boardKey: string, side: OverlaySide): Promise<Blob> {
  const response = await fetch(buildOverlayUrl(boardKey, side, 'source'), {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`Das gespeicherte Foto konnte nicht geladen werden (HTTP ${response.status}).`);
  }
  return response.blob();
}

function PanelContent({
  tabId,
  board,
  onBeginImport,
  onBeginRecalibration,
  onSubboardSelected,
}: {
  tabId: number;
  board: BoardData | null;
  onBeginImport: (file: File, side: OverlaySide, boardKey: string, subboardIndex: number) => void;
  onBeginRecalibration: (side: OverlaySide, boardKey: string, subboardIndex: number) => void;
  onSubboardSelected: (subboardIndex: number) => void;
}) {
  const panel = usePhotoOverlayPanel(tabId, { onBeginImport, onBeginRecalibration });
  const { onSubboardChange, subboards } = panel;
  const handleSubboardChange = useCallback((key: string): void => {
    onSubboardChange(key);
    const index = subboards.findIndex((subboard) => subboard.key === key);
    if (index >= 0 && board?.boards && board.boards.length > 0) {
      boardStore.setSelectedBoardIndex(index);
    }
    if (index >= 0) onSubboardSelected(index);
  }, [board, onSubboardChange, onSubboardSelected, subboards]);

  return <PhotoOverlayPanel {...panel} onSubboardChange={handleSubboardChange} />;
}

/** Endnutzer-Integration für den bestehenden Panel-/Kalibrierungs-Vertrag. */
export function PhotoOverlayIntegration({ tabId, board }: PhotoOverlayIntegrationProps) {
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [panelGeneration, setPanelGeneration] = useState(0);
  const saveInProgress = useRef(false);
  const sourceRequest = useRef(0);

  const closeDialog = useCallback((): void => {
    if (saveInProgress.current) return;
    sourceRequest.current += 1;
    setDialog(null);
    setDialogError(null);
    setSourceLoading(false);
  }, []);

  const beginImport = useCallback((file: File, side: OverlaySide, boardKey: string, subboardIndex: number): void => {
    sourceRequest.current += 1;
    const sourceBoard = boardForSubboard(tabId, subboardIndex);
    if (!sourceBoard) {
      setDialogError('Die Boarddaten für dieses Subboard sind nicht mehr verfügbar.');
      return;
    }
    const state = photoOverlayStore.getBoardState(boardKey);
    setDialogError(null);
    setSourceLoading(false);
    setDialog({
      mode: 'import',
      side,
      boardKey,
      board: sourceBoard,
      imageBlob: file,
      // Ein neues/ersetztes Foto bekommt keine alte Geometrie als stillen
      // Entwurf; die bestehende Kalibrierung bleibt bis zum erfolgreichen
      // Speichern unverändert im Store.
      initialCalibration: null,
      initialMask: state.mask,
      hadOverlay: state.sides[side].metadata !== null,
    });
  }, [tabId]);

  const beginRecalibration = useCallback((side: OverlaySide, boardKey: string, subboardIndex: number): void => {
    const sourceBoard = boardForSubboard(tabId, subboardIndex);
    if (!sourceBoard) {
      setDialogError('Die Boarddaten für dieses Subboard sind nicht mehr verfügbar.');
      return;
    }
    const state = photoOverlayStore.getBoardState(boardKey);
    if (!state.sides[side].metadata || !state.sides[side].calibration) {
      setDialogError('Für dieses Overlay sind noch keine Bild- und Kalibrierungsdaten verfügbar.');
      return;
    }
    setDialogError(null);
    setSourceLoading(true);
    const requestId = ++sourceRequest.current;
    setDialog({
      mode: 'recalibrate',
      side,
      boardKey,
      board: sourceBoard,
      imageBlob: null,
      initialCalibration: state.sides[side].calibration,
      initialMask: state.mask,
      hadOverlay: true,
    });
    void loadSourceImage(boardKey, side).then((imageBlob) => {
      if (sourceRequest.current !== requestId) return;
      setDialog((current) => current?.boardKey === boardKey && current.side === side
        ? { ...current, imageBlob }
        : current);
      setSourceLoading(false);
    }).catch((error: unknown) => {
      if (sourceRequest.current !== requestId) return;
      setSourceLoading(false);
      setDialogError(error instanceof Error ? error.message : 'Das gespeicherte Foto konnte nicht geladen werden.');
    });
  }, [tabId]);

  const handleSave = useCallback(async (result: CalibrationDialogResult): Promise<void> => {
    if (!dialog || saveInProgress.current) return;
    saveInProgress.current = true;
    setSaving(true);
    setDialogError(null);
    try {
      if (result.mode === 'import') {
        await putBoardPhotoOverlay(dialog.boardKey, dialog.side, result.photoBlob, result.calibration);
      } else {
        await putBoardPhotoCalibration(dialog.boardKey, dialog.side, result.calibration);
      }

      if (result.manualMask && !sameValue(result.manualMask, dialog.initialMask)) {
        await putBoardPhotoMask(dialog.boardKey, result.manualMask);
      }

      await photoOverlayStore.loadAsset(dialog.boardKey);
      if (!dialog.hadOverlay) {
        await setOverlayDisplayPreferences(dialog.boardKey, dialog.side, { visible: true, opacity: 0.5 });
      }
      setDialog(null);
      setPanelGeneration((value) => value + 1);
    } catch (error: unknown) {
      setDialogError(error instanceof Error ? error.message : 'Das Foto-Overlay konnte nicht gespeichert werden.');
    } finally {
      saveInProgress.current = false;
      setSaving(false);
    }
  }, [dialog]);

  useEffect(() => () => {
    saveInProgress.current = false;
    sourceRequest.current += 1;
  }, []);

  return (
    <>
      {dialogError && !dialog && <p className="photo-overlay-panel__mode-notice" role="alert">{dialogError}</p>}
      <PanelContent
        key={panelGeneration}
        tabId={tabId}
        board={board}
        onBeginImport={beginImport}
        onBeginRecalibration={beginRecalibration}
        onSubboardSelected={() => setDialogError(null)}
      />
      {dialog && (
        <div
          data-testid="photo-overlay-calibration-host"
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: 16,
            background: 'rgba(0, 0, 0, 0.62)',
          }}
        >
          {sourceLoading || (dialog.mode === 'recalibrate' && dialog.imageBlob === null) ? (
            <div role={dialogError ? 'alert' : 'status'} style={{ padding: 20, borderRadius: 8, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
              {dialogError ?? 'Gespeichertes Foto wird geladen …'}
              <button type="button" onClick={closeDialog} style={{ marginLeft: 12 }}>Abbrechen</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
              {dialogError && <p className="photo-overlay-calibration__error" role="alert">{dialogError}</p>}
              <CalibrationDialog
                board={dialog.board}
                imageBlob={dialog.imageBlob}
                mode={dialog.mode}
                initialCalibration={dialog.initialCalibration}
                initialMask={dialog.initialMask}
                boardDimensions={boardDimensions(dialog.board)}
                onSave={(result) => { void handleSave(result); }}
                onCancel={closeDialog}
              />
              {saving && <p role="status" style={{ color: 'var(--text-primary)' }}>Speichern …</p>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
