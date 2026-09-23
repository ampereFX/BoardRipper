import { useRef, useState } from 'react';
import type { DragEvent, ChangeEvent } from 'react';
import type { OverlaySide } from '../../photo-overlay/types';
import { firstPhotoOverlayFile, PHOTO_OVERLAY_ACCEPT, validatePhotoOverlayFile } from './file-validation';
import type { PhotoOverlayCardProps } from './types';
import './photo-overlay.css';

function sideLabel(side: OverlaySide): string {
  return side === 'top' ? 'Oberseite' : 'Unterseite';
}

function statusLabel(status: PhotoOverlayCardProps['status']): string {
  if (status === 'loading') return 'Wird geladen';
  if (status === 'error') return 'Fehler';
  if (status === 'ready') return 'Bereit';
  return 'Kein Foto';
}

function displayOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function PhotoOverlayCard({
  side,
  status,
  metadata,
  previewUrl,
  error,
  visible,
  opacity,
  disabled = false,
  onImport,
  onVisibilityChange,
  onOpacityChange,
  onRecalibrate,
  onRemove,
}: PhotoOverlayCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastReportedOpacity = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const interactionDisabled = disabled || status === 'loading';
  const label = sideLabel(side);
  const hasOverlay = status === 'ready' && metadata !== null;
  const safeOpacity = displayOpacity(opacity);

  const importFile = (file: File | null): void => {
    const validation = validatePhotoOverlayFile(file);
    if (!validation.valid || !file) {
      setFileError(file
        ? 'Nur Bilder im Format JPEG (.jpg/.jpeg) und PNG (.png) werden unterstützt.'
        : 'Bitte ein JPEG- oder PNG-Bild auswählen.');
      return;
    }
    setFileError(null);
    onImport(file, side);
  };

  const handlePickerChange = (event: ChangeEvent<HTMLInputElement>): void => {
    importFile(firstPhotoOverlayFile(event.currentTarget.files));
    // Selecting the same file a second time must still fire a change event.
    event.currentTarget.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    setDragging(false);
    if (interactionDisabled) return;
    importFile(firstPhotoOverlayFile(event.dataTransfer.files));
  };

  const handleDragOver = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    if (!interactionDisabled) setDragging(true);
  };

  const handleDragLeave = (): void => setDragging(false);

  const chooseFile = (): void => {
    if (!interactionDisabled) fileInputRef.current?.click();
  };

  const reportOpacity = (value: number): void => {
    if (lastReportedOpacity.current === value) return;
    lastReportedOpacity.current = value;
    onOpacityChange(value, side);
  };

  return (
    <article
      className="photo-overlay-card"
      data-testid={`photo-overlay-card-${side}`}
      data-disabled={interactionDisabled ? 'true' : 'false'}
      aria-busy={status === 'loading'}
    >
      <header className="photo-overlay-card__header">
        <h3 className="photo-overlay-card__title">{label}</h3>
        <span className="photo-overlay-card__status" data-testid={`photo-overlay-status-${side}`}>
          {statusLabel(status)}
        </span>
      </header>

      <div className="photo-overlay-card__preview" data-testid={`photo-overlay-preview-${side}`}>
        {previewUrl && status === 'ready' ? (
          <img src={previewUrl} alt={`${label}-Vorschau`} />
        ) : status === 'loading' ? (
          <div className="photo-overlay-card__preview-status" role="status">Vorschau wird geladen…</div>
        ) : status === 'error' ? (
          <div className="photo-overlay-card__preview-status photo-overlay-card__error" role="alert">
            {error ?? 'Das Overlay konnte nicht geladen werden.'}
          </div>
        ) : (
          <div className="photo-overlay-card__preview-status photo-overlay-card__empty">
            {metadata ? 'Vorschau nicht verfügbar.' : 'Kein Foto-Overlay importiert.'}
          </div>
        )}
      </div>

      {metadata && (
        <p className="photo-overlay-card__metadata">
          {metadata.widthPx} × {metadata.heightPx} px · {metadata.mimeType}
        </p>
      )}

      <input
        ref={fileInputRef}
        className="photo-overlay-card__file-input"
        type="file"
        accept={PHOTO_OVERLAY_ACCEPT}
        disabled={interactionDisabled}
        onChange={handlePickerChange}
        aria-label={`JPEG oder PNG für die ${label} auswählen`}
        data-testid={`photo-overlay-file-input-${side}`}
      />
      <button
        type="button"
        className="photo-overlay-card__dropzone"
        disabled={interactionDisabled}
        data-dragging={dragging ? 'true' : 'false'}
        data-testid={`photo-overlay-dropzone-${side}`}
        onClick={chooseFile}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        aria-label={`JPEG oder PNG für die ${label} auswählen oder hier ablegen`}
      >
        <span className="photo-overlay-card__dropzone-title">{hasOverlay ? 'Foto ersetzen' : 'Foto importieren'}</span>
        <span className="photo-overlay-card__dropzone-hint">JPEG oder PNG · anklicken oder per Drag-and-drop ablegen</span>
      </button>
      {fileError && (
        <p className="photo-overlay-card__error" role="alert" data-testid={`photo-overlay-file-error-${side}`}>
          {fileError}
        </p>
      )}

      {hasOverlay && (
        <div className="photo-overlay-card__controls" aria-label={`Steuerelemente für die ${label}`}>
          <div className="photo-overlay-card__visibility">
            <input
              id={`photo-overlay-visible-${side}`}
              type="checkbox"
              checked={visible}
              disabled={interactionDisabled}
              onChange={(event) => onVisibilityChange(event.currentTarget.checked, side)}
              data-testid={`photo-overlay-visible-${side}`}
            />
            <label htmlFor={`photo-overlay-visible-${side}`}>Sichtbar</label>
          </div>

          <div className="photo-overlay-card__opacity">
            <label htmlFor={`photo-overlay-opacity-${side}`}>Deckkraft</label>
            <input
              id={`photo-overlay-opacity-${side}`}
              className="photo-overlay-card__range"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={safeOpacity}
              disabled={interactionDisabled}
              onInput={(event) => reportOpacity(Number(event.currentTarget.value))}
              onChange={(event) => reportOpacity(Number(event.currentTarget.value))}
              data-testid={`photo-overlay-opacity-${side}`}
              aria-valuetext={`${Math.round(safeOpacity * 100)} Prozent`}
            />
            <span className="photo-overlay-card__opacity-value">{Math.round(safeOpacity * 100)}%</span>
          </div>

          {!confirmingDelete ? (
            <div className="photo-overlay-card__actions">
              <button
                type="button"
                className="photo-overlay-card__action"
                disabled={interactionDisabled}
                onClick={() => onRecalibrate(side)}
                data-testid={`photo-overlay-recalibrate-${side}`}
              >
                Neu kalibrieren
              </button>
              <button
                type="button"
                className="photo-overlay-card__action photo-overlay-card__action--danger"
                disabled={interactionDisabled}
                onClick={() => setConfirmingDelete(true)}
                data-testid={`photo-overlay-remove-${side}`}
              >
                Entfernen
              </button>
            </div>
          ) : (
            <div className="photo-overlay-card__confirm" role="alertdialog" aria-label={`Overlay der ${label} entfernen`}>
              <p className="photo-overlay-card__confirm-text">Dieses Foto-Overlay entfernen?</p>
              <div className="photo-overlay-card__confirm-actions">
                <button
                  type="button"
                  className="photo-overlay-card__confirm-button"
                  onClick={() => setConfirmingDelete(false)}
                  data-testid={`photo-overlay-remove-cancel-${side}`}
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  className="photo-overlay-card__confirm-button photo-overlay-card__confirm-button--danger"
                  onClick={() => {
                    setConfirmingDelete(false);
                    onRemove(side);
                  }}
                  data-testid={`photo-overlay-remove-confirm-${side}`}
                >
                  Entfernen
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
