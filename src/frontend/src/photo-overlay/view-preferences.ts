/** Lokale Anzeigepräferenzen für PCB-Foto-Overlays.
 *
 *  Gespeichert wird nur der Anzeigezustand (visible + opacity), strikt
 *  anhand boardKey + OverlaySide — unabhängig von Dateipfad oder Session.
 *  Dieselbe Boardgeometrie hat auf zwei Rechnern also ggf. verschiedene
 *  Einstellungen; das ist gewollt, da es sich um lokale Präferenzen handelt.
 *
 *  Die Persistenz nutzt denselben IndexedDB-Mechanismus wie der
 *  File-View-Prefs-Store (DB `boardripper-file-view-prefs`, Version 2),
 *  aber einen eigenen Object Store `overlay-prefs`, damit File-Overrides
 *  und Overlay-Präferenzen einander nie in die Quere kommen.
 *
 *  Defaults beim ersten Kontakt mit einem Overlay: visible=true,
 *  opacity=0.5. opacity wird robust auf 0..1 begrenzt (inkl. NaN → 0.5-Default).
 */

import {
  fileViewPrefsStore,
} from '../store/file-view-prefs-store';
import type { OverlayDisplayPreferences, OverlaySide } from './types';

const DEFAULT_PREFS: OverlayDisplayPreferences = { visible: true, opacity: 0.5 };

function makeKey(boardKey: string, side: OverlaySide): string {
  return `${boardKey}|${side}`;
}

/** Begrenzt opacity auf 0..1; nicht-numerische Werte fallen auf den Default. */
function clampOpacity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PREFS.opacity;
  return Math.min(1, Math.max(0, value));
}

/** Lies die gespeicherte Präferenz. Gibt die Defaults zurück, wenn (noch)
 *  keine Präferenz existiert — so ist der erste Overlay-Kontakt sichtbar. */
export async function loadOverlayDisplayPreferences(
  boardKey: string,
  side: OverlaySide,
): Promise<OverlayDisplayPreferences> {
  const raw = await fileViewPrefsStore.getOverlayPrefs(makeKey(boardKey, side));
  if (!raw) return { ...DEFAULT_PREFS };
  return {
    visible: typeof raw.visible === 'boolean' ? raw.visible : DEFAULT_PREFS.visible,
    opacity: clampOpacity(raw.opacity),
  };
}

/** Setzt die Präferenz für genau eine Boardseite. opacity wird auf 0..1
 *  begrenzt gespeichert; ein fehlender/gemischter Wert fällt auf die Defaults. */
export async function setOverlayDisplayPreferences(
  boardKey: string,
  side: OverlaySide,
  prefs: Partial<OverlayDisplayPreferences>,
): Promise<void> {
  const current = await loadOverlayDisplayPreferences(boardKey, side);
  const next: OverlayDisplayPreferences = {
    visible: prefs.visible ?? current.visible,
    opacity: clampOpacity(prefs.opacity ?? current.opacity),
  };
  await fileViewPrefsStore.putOverlayPrefs(makeKey(boardKey, side), next);
}

/** Löscht die gespeicherte Präferenz — der nächste Ladevorgang zeigt wieder
 *  die Defaults. Existiert keine Präferenz, ist das ein No-op. */
export async function clearOverlayDisplayPreferences(
  boardKey: string,
  side: OverlaySide,
): Promise<void> {
  await fileViewPrefsStore.deleteOverlayPrefs(makeKey(boardKey, side));
}
