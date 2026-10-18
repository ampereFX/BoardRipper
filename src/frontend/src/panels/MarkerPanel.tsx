import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { IconMapPin, IconRefresh, IconSearch, IconTrash } from '@tabler/icons-react';
import { boardStore } from '../store/board-store';
import { markerStore } from '../markers/marker-store';
import type { Marker } from '../markers/marker-store';
import { relativeToBoardPoint } from '../markers/board-identity';
import type { ResolvedMarkerIdentity } from '../markers/board-identity';
import { openMarkerPanel, navigateToMarker } from './board-viewer-bridge';
import './marker-panel.css';

const COLORS = ['#e45757', '#f0a23b', '#e6ca45', '#56ad72', '#4d91d0', '#a16bd1'];
const EMPTY_IDENTITIES: ResolvedMarkerIdentity[] = [];

interface MarkerPanelProps {
  tabId: number;
  subboardCount: number;
  focusMarkerId: string | null;
  onFocusHandled: () => void;
}

function useMarkerSnapshot() {
  return useSyncExternalStore(
    (notify) => markerStore.subscribe(() => notify()),
    () => markerStore.getSnapshot(),
  );
}

function sideName(side: Marker['side']): string {
  return side === 'both' ? 'Beide Seiten' : side === 'top' ? 'Top' : 'Bottom';
}

export function MarkerPanel({ tabId, subboardCount, focusMarkerId, onFocusHandled }: MarkerPanelProps) {
  const snapshot = useMarkerSnapshot();
  const [resolvedIdentityState, setResolvedIdentityState] = useState<{
    key: string;
    identities: ResolvedMarkerIdentity[];
    error: string | null;
  } | null>(null);
  const [query, setQuery] = useState('');
  const noteInputs = useRef(new Map<string, HTMLTextAreaElement>());
  const identityRequestKey = `${tabId}:${subboardCount}`;

  useEffect(() => { void markerStore.hydrate(); }, []);

  useEffect(() => {
    let active = true;
    void Promise.all(Array.from({ length: subboardCount }, (_, index) => markerStore.resolveIdentity(tabId, index))).then((resolved) => {
      if (!active) return;
      const valid = resolved.filter((entry): entry is ResolvedMarkerIdentity => entry !== null);
      setResolvedIdentityState({
        key: identityRequestKey,
        identities: valid,
        error: valid.length === 0 ? 'Board-Position ist noch nicht verfügbar.' : null,
      });
    }).catch((error: unknown) => {
      if (!active) return;
      setResolvedIdentityState({
        key: identityRequestKey,
        identities: [],
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return () => { active = false; };
  }, [identityRequestKey, tabId, subboardCount]);

  const resolvedForCurrentBoard = resolvedIdentityState?.key === identityRequestKey ? resolvedIdentityState : null;
  const identities = resolvedForCurrentBoard?.identities ?? EMPTY_IDENTITIES;
  const identityError = resolvedForCurrentBoard?.error ?? null;
  const identity = identities[0];
  const needle = query.trim().toLowerCase();
  const markers = useMemo(() => identity
    ? snapshot.markers
      .filter((marker) => marker.fileKey === identity.fileKey)
      .filter((marker) => !needle || [marker.name, marker.net ?? '', marker.note]
        .some((value) => value.toLowerCase().includes(needle)))
      .filter((marker) => identities.some((entry) => entry.subboardKey === marker.subboardKey))
      .sort((a, b) => b.createdAt - a.createdAt)
    : [], [identities, identity, needle, snapshot.markers]);

  useEffect(() => {
    if (!focusMarkerId) return;
    const input = noteInputs.current.get(focusMarkerId);
    if (!input) return;
    input.focus();
    onFocusHandled();
  }, [focusMarkerId, markers, onFocusHandled]);

  const removeMarker = async (marker: Marker) => {
    const removed = await markerStore.remove(marker.id);
    if (!removed) {
      const error = markerStore.getSnapshot().runtime[marker.id]?.error;
      boardStore.addToast(`Marker konnte nicht gelöscht werden${error ? `: ${error}` : '.'}`, 'error');
      return;
    }
    markerStore.selectMarker(null);
    boardStore.addToast(`Marker „${marker.name || 'Ohne Namen'}“ gelöscht`, 'info', {
      label: 'Rückgängig',
      run: () => { void markerStore.restore(marker); },
    });
  };

  const databaseError = snapshot.runtime.$database?.error;

  return (
    <section className="marker-panel" data-testid="marker-panel">
      <header className="marker-panel__header">
        <div>
          <h2>Markers</h2>
          <p>Positionen auf diesem Board</p>
        </div>
        <span className="marker-panel__count" aria-label={`${markers.length} Marker`}>
          {markers.length}
        </span>
      </header>

      <label className="marker-panel__search">
        <IconSearch size={16} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, Net oder Notiz suchen"
          aria-label="Marker suchen"
          data-testid="marker-search"
        />
      </label>

      {databaseError && (
        <div className="marker-panel__error" role="alert">
          <span>Marker konnten nicht geladen werden: {databaseError}</span>
          <button type="button" onClick={() => void markerStore.retry('$database')}>
            <IconRefresh size={14} /> Erneut versuchen
          </button>
        </div>
      )}
      {identityError && <div className="marker-panel__empty" role="status">{identityError}</div>}
      {!identityError && identities.length === 0 && <div className="marker-panel__empty" role="status">Marker werden geladen…</div>}
      {identities.length > 0 && markers.length === 0 && (
        <div className="marker-panel__empty" data-testid="marker-empty">
          <IconMapPin size={22} aria-hidden="true" />
          <strong>{query ? 'Keine Treffer' : 'Noch keine Marker'}</strong>
          <span>{query ? 'Passe den Suchbegriff an.' : 'Rechtsklicke auf das Board und markiere eine Position.'}</span>
        </div>
      )}

      {identities.length > 0 && markers.length > 0 && (
        <div className="marker-panel__list" data-testid="marker-list">
          {markers.map((marker) => {
            const markerIdentity = identities.find((entry) => entry.subboardKey === marker.subboardKey);
            if (!markerIdentity) return null;
            const point = relativeToBoardPoint({ bounds: markerIdentity.bounds }, marker);
            const runtime = snapshot.runtime[marker.id];
            const selected = snapshot.selectedMarkerId === marker.id;
            return (
              <MarkerRow
                key={marker.id}
                marker={marker}
                location={`Board ${identities.indexOf(markerIdentity) + 1} · ${Math.round(point.x)}, ${Math.round(point.y)} mil`}
                runtime={runtime}
                selected={selected}
                noteRef={(element) => {
                  if (element) noteInputs.current.set(marker.id, element);
                  else noteInputs.current.delete(marker.id);
                }}
                onSelect={() => {
                  markerStore.selectMarker(marker.id);
                  openMarkerPanel(tabId, marker.id);
                  navigateToMarker(tabId, marker.id);
                }}
                onDelete={() => { void removeMarker(marker); }}
                expanded={selected}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function MarkerRow({
  marker,
  location,
  runtime,
  selected,
  noteRef,
  onSelect,
  onDelete,
  expanded,
}: {
  marker: Marker;
  location: string;
  runtime?: { status: string; error: string | null };
  selected: boolean;
  noteRef: (element: HTMLTextAreaElement | null) => void;
  onSelect: () => void;
  onDelete: () => void;
  expanded: boolean;
}) {
  return (
    <article className={`marker-row${selected ? ' is-selected' : ''}`} data-testid={`marker-row-${marker.id}`}>
      <button
        className="marker-row__navigate"
        type="button"
        onClick={onSelect}
        aria-label={`Board-Position von ${marker.name || 'Marker'} öffnen`}
        title="Board-Position öffnen"
      >
        <span className="marker-row__swatch" style={{ backgroundColor: marker.color }} />
        <span className="marker-row__heading">
          <strong>{marker.name || 'Ohne Namen'}</strong>
          <small>{marker.context ? `${marker.context} · ` : ''}{location} · {sideName(marker.side)}</small>
          {marker.net && <small className="marker-row__net">Net: {marker.net}</small>}
        </span>
      </button>

      {expanded ? (
        <>
          <label className="marker-row__field">
            <span>Name</span>
            <input
              value={marker.name}
              onChange={(event) => { void markerStore.update(marker.id, { name: event.target.value }); }}
              aria-label={`Name für ${marker.name || 'Marker'}`}
              data-testid={`marker-name-${marker.id}`}
            />
          </label>
          <label className="marker-row__field">
            <span>Notiz</span>
            <textarea
              ref={noteRef}
              value={marker.note}
              onChange={(event) => { void markerStore.update(marker.id, { note: event.target.value }); }}
              placeholder="Notiz hinzufügen…"
              aria-label={`Notiz für ${marker.name || 'Marker'}`}
              data-testid={`marker-note-${marker.id}`}
              rows={2}
            />
          </label>
        </>
      ) : (
        <p className="marker-row__preview">{marker.note || 'Keine Notiz'}</p>
      )}

      <div className="marker-row__footer">
        {expanded && <div className="marker-row__colors" aria-label="Markerfarbe">
          {COLORS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`marker-row__color${marker.color.toLowerCase() === preset ? ' is-current' : ''}`}
              style={{ backgroundColor: preset }}
              aria-label={`Farbe ${preset}`}
              aria-pressed={marker.color.toLowerCase() === preset}
              onClick={() => { void markerStore.update(marker.id, { color: preset }); }}
            />
          ))}
          <label className="marker-row__custom-color" title="Eigene Farbe">
            <input
              type="color"
              value={marker.color}
              onChange={(event) => { void markerStore.update(marker.id, { color: event.target.value }); }}
              aria-label="Eigene Markerfarbe"
            />
          </label>
        </div>}
        <span className={`marker-row__status marker-row__status--${runtime?.status ?? 'saved'}`} role="status">
          {runtime?.status === 'pending' ? 'Speichert…' : runtime?.status === 'error' ? 'Fehler' : 'Gespeichert'}
        </span>
        <button type="button" className="marker-row__delete" onClick={onDelete} aria-label={`Marker ${marker.name || 'ohne Namen'} löschen`}>
          <IconTrash size={15} />
        </button>
      </div>
      {runtime?.status === 'error' && (
        <div className="marker-row__error" role="alert">
          <span>{runtime.error ?? 'Änderung konnte nicht gespeichert werden.'}</span>
          <button type="button" onClick={() => void markerStore.retry(marker.id)}>
            <IconRefresh size={14} /> Erneut versuchen
          </button>
        </div>
      )}
    </article>
  );
}
