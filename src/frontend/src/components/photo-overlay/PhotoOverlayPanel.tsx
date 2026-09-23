import type { ChangeEvent } from 'react';
import { PhotoOverlayCard } from './PhotoOverlayCard';
import type { PhotoOverlayPanelProps } from './types';
import './photo-overlay.css';

function modeNotice(mode: NonNullable<PhotoOverlayPanelProps['mode']>): string {
  if (mode === 'offline') {
    return 'Foto-Overlays sind im Offline-Modus nicht verfügbar, da kein verbundener Asset-Dienst vorhanden ist.';
  }
  return 'Foto-Overlays sind im Lite-Modus nicht verfügbar. Öffne das Board in der Desktop-App, um Fotos zu importieren.';
}

export function PhotoOverlayPanel({
  subboards,
  selectedSubboardKey,
  onSubboardChange,
  cards,
  mode = 'online',
  disabled = false,
  className,
}: PhotoOverlayPanelProps) {
  const modeDisabled = mode !== 'online';
  const panelDisabled = disabled || modeDisabled;
  const selectedSubboard = subboards.find((subboard) => subboard.key === selectedSubboardKey);
  const selectDisabled = panelDisabled || subboards.length === 0;
  const cardDisabled = panelDisabled || selectedSubboard === undefined;
  const classes = ['photo-overlay-panel', className].filter(Boolean).join(' ');

  const handleSubboardChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    if (!panelDisabled && event.currentTarget.value) onSubboardChange(event.currentTarget.value);
  };

  return (
    <section className={classes} data-testid="photo-overlay-panel" aria-disabled={panelDisabled}>
      <header className="photo-overlay-panel__header">
        <h2 className="photo-overlay-panel__title">Fotos</h2>
        <span className="photo-overlay-panel__subtitle">Fotos der Leiterplatte</span>
      </header>

      {modeDisabled && (
        <p className="photo-overlay-panel__mode-notice" role="note" data-testid="photo-overlay-mode-notice">
          {modeNotice(mode)}
        </p>
      )}

      <div className="photo-overlay-panel__selector">
        <label className="photo-overlay-panel__selector-label" htmlFor="photo-overlay-subboard">
          Physisches Einzelboard
        </label>
        {subboards.length > 0 ? (
          <select
            id="photo-overlay-subboard"
            className="photo-overlay-panel__select"
            value={selectedSubboardKey ?? ''}
            disabled={selectDisabled}
            onChange={handleSubboardChange}
            data-testid="photo-overlay-subboard-select"
          >
            <option value="" disabled>Physisches Einzelboard auswählen</option>
            {subboards.map((subboard) => (
              <option key={subboard.key} value={subboard.key} disabled={subboard.disabled}>
                {subboard.label}{subboard.description ? ` — ${subboard.description}` : ''}
              </option>
            ))}
          </select>
        ) : (
          <p className="photo-overlay-panel__empty" data-testid="photo-overlay-no-subboards">
            Für dieses Board sind keine physischen Einzelboards verfügbar.
          </p>
        )}
      </div>

      <div className="photo-overlay-panel__cards">
        {(['top', 'bottom'] as const).map((side) => (
          <PhotoOverlayCard
            key={side}
            {...cards[side]}
            disabled={cards[side].disabled || cardDisabled}
          />
        ))}
      </div>
    </section>
  );
}
