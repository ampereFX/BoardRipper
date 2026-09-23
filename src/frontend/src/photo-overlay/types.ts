/** Welche Plattenseite ein Foto zeigt. */
export type OverlaySide = 'top' | 'bottom';

/** Normalisierte Koordinate im Bereich 0..1. */
export interface NormalizedPoint {
  x: number;
  y: number;
}

/** Ein Kalibrierpunkt: dieselbe physische Stelle einmal in Board- und einmal
 *  in Foto-Koordinaten, beide normalisiert (0..1, bezogen auf Board-Bounds
 *  bzw. Bildgröße). Die positive Ganzzahl-id ist nur für die Zuordnung im UI
 *  gedacht und fließt nicht in Berechnungen ein. */
export interface CalibrationPointPair {
  id: number;
  board: NormalizedPoint;
  photo: NormalizedPoint;
}

/** Status eines Homografie-Lösens. 'ok' = belastbar, 'degraded' = brauchbar,
 *  aber mit Warnungen, 'error' = Mathefehler, Matrix ist null und darf nicht
 *  verwendet werden. */
export type HomographyStatus = 'ok' | 'degraded' | 'error';

/** Ergebnis des Homografie-Lösens. Die Matrix ist row-major h11..h33. */
export interface HomographyResult {
  matrix: number[] | null;
  status: HomographyStatus;
  /** RMS- und Max-Reprojektionsfehler relativ zur Boarddiagonale, ab 5 Paaren. */
  rmsError: number | null;
  maxError: number | null;
  warnings: string[];
  /** Menschlich lesbare Ursache, wenn status === 'error'. */
  error: string | null;
}

/** Kalibrierung eines Fotos gegen die Boardgeometrie (eingefrorener
 *  P0-Wire-Vertrag): nur Version und 4 bis 12 vollständige Punkt-Paare in
 *  normalisierten Koordinaten. Die Homografie wird im Frontend aus den
 *  Paaren berechnet und ist kein Teil der persistierten/senden Daten. */
export interface PhotoCalibration {
  version: 1;
  points: CalibrationPointPair[];
}

/** Manuell gezeichnete Außenkontur des Boards im Foto. Geschlossen implizit
 *  (letzter Punkt verbindet zum ersten), keine Löcher. Mindestens drei
 *  Punkte in normalisierten Koordinaten. */
export interface ManualBoardMask {
  /** Außenkontur in normalisierten Foto-Koordinaten. */
  points: NormalizedPoint[];
}

/** Metadaten des lokalen Bild-Assets. */
export interface OverlayAssetMetadata {
  id: string;
  mimeType: string;
  widthPx: number;
  heightPx: number;
}

/** Zuordnung eines Assets zu einer konkreten Subboard-Seite. */
export interface OverlayMetadata {
  assetId: string;
  subboardKey: string;
  side: OverlaySide;
}

/** Lokale Anzeigepräferenzen (keine portablen Kalibrierdaten). */
export interface OverlayDisplayPreferences {
  visible: boolean;
  /** Deckkraft, 0..1. */
  opacity: number;
}
