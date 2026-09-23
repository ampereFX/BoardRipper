import { solveHomography } from './homography';
import type { BoardDimensions } from './homography';
import { validateManualBoardMask } from './mask-validation';
import type {
  CalibrationPointPair,
  HomographyResult,
  ManualBoardMask,
  NormalizedPoint,
  PhotoCalibration,
} from './types';
import type { MaskValidationResult } from './mask-validation';

export const MIN_CALIBRATION_PAIRS = 4;
export const MAX_CALIBRATION_PAIRS = 12;
export const RECOMMENDED_CALIBRATION_PAIRS = 6;
export const REPROJECTION_WARNING_THRESHOLD = 0.0075;

export type CalibrationPreviewMode = 'reference' | 'photo' | 'compare';
export type CalibrationViewportName = 'reference' | 'photo';

export interface CalibrationViewport {
  zoom: number;
  pan: NormalizedPoint;
}

export interface CalibrationSessionOptions {
  /** Physische Boardabmessungen für die Reprojektionsfehler-Metrik. */
  boardDimensions?: BoardDimensions;
  initialCalibration?: PhotoCalibration | null;
  initialMask?: ManualBoardMask | null;
  /** Aliase für Aufrufer, die den aktuellen Entwurf direkt übergeben. */
  calibration?: PhotoCalibration | null;
  manualMask?: ManualBoardMask | null;
  /** Normalisierte, geschlossene Board-Außenkontur. */
  boardOutline?: ReadonlyArray<NormalizedPoint>;
  outlineSnapDistance?: number;
}

export interface CalibrationSessionStatistics {
  rmsError: number;
  maxError: number;
}

export interface CalibrationSessionValidation {
  homography: HomographyResult;
  valid: boolean;
  statistics: CalibrationSessionStatistics | null;
  warnings: string[];
  requiresConfirmation: boolean;
  warningConfirmed: boolean;
  canCommit: boolean;
  isRecommended: boolean;
  mask: MaskValidationResult | null;
}

export interface CalibrationSessionState {
  pairs: CalibrationPointPair[];
  activePairId: number | null;
  /** Ein angeklickter Boardpunkt, für den noch der Fotopunkt fehlt. */
  pendingBoardPoint: NormalizedPoint | null;
  preview: CalibrationPreviewMode;
  referenceViewport: CalibrationViewport;
  photoViewport: CalibrationViewport;
  outlineSnap: boolean;
  manualMask: ManualBoardMask | null;
  cancelled: boolean;
  validation: CalibrationSessionValidation;
}

export interface NumberedCalibrationPair {
  number: number;
  pair: CalibrationPointPair;
}

export class CalibrationSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalibrationSessionError';
  }
}

const DEFAULT_VIEWPORT: CalibrationViewport = { zoom: 1, pan: { x: 0, y: 0 } };
const DEFAULT_BOARD_DIMENSIONS: BoardDimensions = { width: 1, height: 1 };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 50;

function clonePoint(point: NormalizedPoint): NormalizedPoint {
  return { x: point.x, y: point.y };
}

function cloneBoardDimensions(dimensions: BoardDimensions): BoardDimensions {
  return { width: dimensions.width, height: dimensions.height };
}

function assertBoardDimensions(dimensions: BoardDimensions): void {
  if (!dimensions
    || !Number.isFinite(dimensions.width) || dimensions.width <= 0
    || !Number.isFinite(dimensions.height) || dimensions.height <= 0) {
    throw new CalibrationSessionError('Breite und Höhe des Boards müssen positiv und endlich sein.');
  }
}

function clonePair(pair: CalibrationPointPair): CalibrationPointPair {
  return { id: pair.id, board: clonePoint(pair.board), photo: clonePoint(pair.photo) };
}

function cloneMask(mask: ManualBoardMask | null): ManualBoardMask | null {
  return mask ? { points: mask.points.map(clonePoint) } : null;
}

function cloneCalibration(calibration: PhotoCalibration | null): PhotoCalibration | null {
  return calibration
    ? { version: calibration.version, points: calibration.points.map(clonePair) }
    : null;
}

function cloneViewport(viewport: CalibrationViewport): CalibrationViewport {
  return { zoom: viewport.zoom, pan: clonePoint(viewport.pan) };
}

function cloneHomography(result: HomographyResult): HomographyResult {
  return {
    ...result,
    matrix: result.matrix ? [...result.matrix] : null,
    warnings: [...result.warnings],
  };
}

function assertPoint(point: NormalizedPoint): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new CalibrationSessionError('Kalibrierpunkte müssen in normalisierten Koordinaten 0..1 liegen.');
  }
}

function assertIndex(index: number, length: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new CalibrationSessionError(`Ungültiger Index für ${what}.`);
  }
}

function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) throw new CalibrationSessionError('Der Zoom muss endlich sein.');
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function nearestPointOnSegment(
  point: NormalizedPoint,
  start: NormalizedPoint,
  end: NormalizedPoint,
): NormalizedPoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return clonePoint(start);
  const t = Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return { x: start.x + t * dx, y: start.y + t * dy };
}

/** Snapt einen Punkt auf die nächste Konturkante, wenn sie nahe genug liegt. */
export function snapToOutline(
  point: NormalizedPoint,
  outline: ReadonlyArray<NormalizedPoint>,
  maxDistance = 0.025,
): NormalizedPoint {
  assertPoint(point);
  if (!Number.isFinite(maxDistance) || maxDistance < 0) {
    throw new CalibrationSessionError('Der Outline-Snap-Abstand muss endlich und nichtnegativ sein.');
  }

  const paths: NormalizedPoint[][] = [];
  let path: NormalizedPoint[] = [];
  const finishPath = () => {
    if (path.length > 0) paths.push(path);
    path = [];
  };
  for (const candidate of outline) {
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) {
      finishPath();
      continue;
    }
    assertPoint(candidate);
    path.push(candidate);
  }
  finishPath();

  let nearest: NormalizedPoint | null = null;
  let nearestDistance = maxDistance;
  for (const currentPath of paths) {
    if (currentPath.length === 1) {
      const distance = Math.hypot(point.x - currentPath[0].x, point.y - currentPath[0].y);
      if (distance <= nearestDistance) {
        nearest = clonePoint(currentPath[0]);
        nearestDistance = distance;
      }
      continue;
    }
    for (let index = 0; index < currentPath.length; index++) {
      const candidate = nearestPointOnSegment(
        point,
        currentPath[index],
        currentPath[(index + 1) % currentPath.length],
      );
      const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
      if (distance <= nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
  }
  return nearest ?? clonePoint(point);
}

export class CalibrationSession {
  private readonly _boardDimensions: BoardDimensions;
  private readonly _boardOutline: NormalizedPoint[];
  private readonly _outlineSnapDistance: number;
  private readonly _initialCalibration: PhotoCalibration | null;
  private readonly _initialMask: ManualBoardMask | null;
  private _pairs: CalibrationPointPair[];
  private _activePairId: number | null;
  private _pendingBoardPoint: NormalizedPoint | null = null;
  private _preview: CalibrationPreviewMode = 'reference';
  private _referenceViewport: CalibrationViewport = cloneViewport(DEFAULT_VIEWPORT);
  private _photoViewport: CalibrationViewport = cloneViewport(DEFAULT_VIEWPORT);
  private _outlineSnap = false;
  private _manualMask: ManualBoardMask | null;
  private _warningConfirmed = false;
  private _cancelled = false;
  private _nextPairNumber = 1;

  constructor(options: CalibrationSessionOptions = {}) {
    const boardDimensions = options.boardDimensions ?? DEFAULT_BOARD_DIMENSIONS;
    assertBoardDimensions(boardDimensions);
    this._boardDimensions = cloneBoardDimensions(boardDimensions);
    this._outlineSnapDistance = options.outlineSnapDistance ?? 0.025;
    if (!Number.isFinite(this._outlineSnapDistance) || this._outlineSnapDistance < 0) {
      throw new CalibrationSessionError('Der Outline-Snap-Abstand muss endlich und nichtnegativ sein.');
    }
    this._boardOutline = (options.boardOutline ?? []).map(clonePoint);
    this._initialCalibration = cloneCalibration(
      options.initialCalibration ?? options.calibration ?? null,
    );
    this._initialMask = cloneMask(options.initialMask ?? options.manualMask ?? null);
    this._pairs = this._initialCalibration?.points.map(clonePair) ?? [];
    this._manualMask = cloneMask(this._initialMask);
    this._activePairId = this._pairs[0]?.id ?? null;
    this._advancePairNumber();
  }

  private _advancePairNumber(): void {
    while (this._pairs.some((pair) => pair.id === this._nextPairNumber)) this._nextPairNumber++;
  }

  private _newPairId(): number {
    this._advancePairNumber();
    const id = this._nextPairNumber;
    this._nextPairNumber++;
    return id;
  }

  private _prepareBoardPoint(point: NormalizedPoint): NormalizedPoint {
    assertPoint(point);
    return this._outlineSnap ? snapToOutline(point, this._boardOutline, this._outlineSnapDistance) : clonePoint(point);
  }

  private _changed(): void {
    this._warningConfirmed = false;
    this._cancelled = false;
  }

  private _ensureOpen(): void {
    if (this._cancelled) throw new CalibrationSessionError('Die Kalibrierung wurde abgebrochen.');
  }

  private _ensureCapacity(): void {
    if (this._pairs.length >= MAX_CALIBRATION_PAIRS) {
      throw new CalibrationSessionError('Es sind höchstens 12 Kalibrierpunkt-Paare erlaubt.');
    }
  }

  /** Fügt ein vollständiges Paar in der festen Reihenfolge Board, Foto hinzu. */
  addPair(board: NormalizedPoint, photo: NormalizedPoint): CalibrationPointPair {
    this._ensureOpen();
    this._ensureCapacity();
    const pair: CalibrationPointPair = {
      id: this._newPairId(),
      board: this._prepareBoardPoint(board),
      photo: clonePoint(photo),
    };
    assertPoint(pair.photo);
    this._pairs.push(pair);
    this._activePairId = pair.id;
    this._pendingBoardPoint = null;
    this._changed();
    return clonePair(pair);
  }

  /** Merkt den Boardpunkt vor, bis der zugehörige Fotopunkt gesetzt wird. */
  addBoardPoint(board: NormalizedPoint): NormalizedPoint {
    this._ensureOpen();
    this._ensureCapacity();
    this._pendingBoardPoint = this._prepareBoardPoint(board);
    return clonePoint(this._pendingBoardPoint);
  }

  /** Schließt das zuvor begonnene Board/Fotopunkt-Paar ab. */
  addPhotoPoint(photo: NormalizedPoint): CalibrationPointPair {
    this._ensureOpen();
    if (!this._pendingBoardPoint) {
      throw new CalibrationSessionError('Zuerst muss ein Boardpunkt gesetzt werden.');
    }
    return this.addPair(this._pendingBoardPoint, photo);
  }

  clearPendingBoardPoint(): void {
    this._pendingBoardPoint = null;
  }

  movePair(id: number, board: NormalizedPoint, photo: NormalizedPoint): CalibrationPointPair {
    this._ensureOpen();
    const index = this._pairs.findIndex((pair) => pair.id === id);
    if (index < 0) throw new CalibrationSessionError(`Unbekanntes Kalibrierpaar: ${id}.`);
    const next = { id, board: this._prepareBoardPoint(board), photo: clonePoint(photo) };
    assertPoint(next.photo);
    this._pairs[index] = next;
    this._changed();
    return clonePair(next);
  }

  moveBoardPoint(id: number, board: NormalizedPoint): CalibrationPointPair {
    const pair = this.getPair(id);
    return this.movePair(id, board, pair.photo);
  }

  movePhotoPoint(id: number, photo: NormalizedPoint): CalibrationPointPair {
    const pair = this.getPair(id);
    return this.movePair(id, pair.board, photo);
  }

  deletePair(id: number): void {
    this._ensureOpen();
    const index = this._pairs.findIndex((pair) => pair.id === id);
    if (index < 0) throw new CalibrationSessionError(`Unbekanntes Kalibrierpaar: ${id}.`);
    this._pairs.splice(index, 1);
    if (this._activePairId === id) {
      this._activePairId = this._pairs[index]?.id ?? this._pairs[index - 1]?.id ?? null;
    }
    this._changed();
  }

  removePair(id: number): void {
    this.deletePair(id);
  }

  selectPair(id: number | null): void {
    this._ensureOpen();
    if (id !== null && !this._pairs.some((pair) => pair.id === id)) {
      throw new CalibrationSessionError(`Unbekanntes Kalibrierpaar: ${id}.`);
    }
    this._activePairId = id;
  }

  setActivePair(id: number | null): void {
    this.selectPair(id);
  }

  getPair(id: number): CalibrationPointPair {
    const pair = this._pairs.find((candidate) => candidate.id === id);
    if (!pair) throw new CalibrationSessionError(`Unbekanntes Kalibrierpaar: ${id}.`);
    return clonePair(pair);
  }

  getActivePair(): CalibrationPointPair | null {
    return this._activePairId === null ? null : this.getPair(this._activePairId);
  }

  getNumberedPairs(): NumberedCalibrationPair[] {
    return this._pairs.map((pair, index) => ({ number: index + 1, pair: clonePair(pair) }));
  }

  setPreview(mode: CalibrationPreviewMode): void {
    this._ensureOpen();
    this._preview = mode;
  }

  setPreviewMode(mode: CalibrationPreviewMode): void {
    this.setPreview(mode);
  }

  setViewport(view: CalibrationViewportName, viewport: Partial<CalibrationViewport>): void {
    this._ensureOpen();
    const current = view === 'reference' ? this._referenceViewport : this._photoViewport;
    const next: CalibrationViewport = {
      zoom: viewport.zoom === undefined ? current.zoom : clampZoom(viewport.zoom),
      pan: viewport.pan === undefined ? clonePoint(current.pan) : clonePoint(viewport.pan),
    };
    if (!Number.isFinite(next.pan.x) || !Number.isFinite(next.pan.y)) {
      throw new CalibrationSessionError('Der Pan muss aus endlichen Koordinaten bestehen.');
    }
    if (view === 'reference') this._referenceViewport = next;
    else this._photoViewport = next;
  }

  setZoom(view: CalibrationViewportName, zoom: number): void {
    this.setViewport(view, { zoom });
  }

  zoomBy(view: CalibrationViewportName, factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) throw new CalibrationSessionError('Der Zoomfaktor muss positiv sein.');
    const current = view === 'reference' ? this._referenceViewport : this._photoViewport;
    this.setZoom(view, current.zoom * factor);
  }

  setPan(view: CalibrationViewportName, pan: NormalizedPoint): void {
    this.setViewport(view, { pan });
  }

  panBy(view: CalibrationViewportName, delta: NormalizedPoint): void {
    if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) {
      throw new CalibrationSessionError('Die Pan-Verschiebung muss aus endlichen Koordinaten bestehen.');
    }
    const current = view === 'reference' ? this._referenceViewport : this._photoViewport;
    this.setPan(view, { x: current.pan.x + delta.x, y: current.pan.y + delta.y });
  }

  setOutlineSnap(enabled: boolean): void {
    this._ensureOpen();
    this._outlineSnap = enabled;
  }

  setManualMask(mask: ManualBoardMask | null): void {
    this._ensureOpen();
    if (mask) {
      for (const point of mask.points) assertPoint(point);
      this._manualMask = cloneMask(mask);
    } else {
      this._manualMask = null;
    }
  }

  addManualMaskPoint(point: NormalizedPoint): void {
    this._ensureOpen();
    assertPoint(point);
    this._manualMask = { points: [...(this._manualMask?.points ?? []), clonePoint(point)] };
  }

  moveManualMaskPoint(index: number, point: NormalizedPoint): void {
    this._ensureOpen();
    if (!this._manualMask) throw new CalibrationSessionError('Es gibt noch keine manuelle Maske.');
    assertIndex(index, this._manualMask.points.length, 'Maskenpunkt');
    assertPoint(point);
    const points = this._manualMask.points.map(clonePoint);
    points[index] = clonePoint(point);
    this._manualMask = { points };
  }

  deleteManualMaskPoint(index: number): void {
    this._ensureOpen();
    if (!this._manualMask) throw new CalibrationSessionError('Es gibt noch keine manuelle Maske.');
    assertIndex(index, this._manualMask.points.length, 'Maskenpunkt');
    this._manualMask = { points: this._manualMask.points.filter((_, pointIndex) => pointIndex !== index).map(clonePoint) };
  }

  clearManualMask(): void {
    this._ensureOpen();
    this._manualMask = null;
  }

  /** Bestätigt den aktuellen Warnfall; eine Degeneration kann nie bestätigt werden. */
  confirmWarning(): void {
    this._ensureOpen();
    const validation = this.getValidation();
    if (!validation.valid) throw new CalibrationSessionError(validation.homography.error ?? 'Kalibrierung ist ungültig.');
    this._warningConfirmed = true;
  }

  getValidation(): CalibrationSessionValidation {
    const homography = solveHomography(this._pairs, this._boardDimensions);
    const hasWarning = homography.warnings.length > 0;
    const statistics = homography.rmsError === null || homography.maxError === null
      ? null
      : { rmsError: homography.rmsError, maxError: homography.maxError };
    const valid = homography.error === null;
    const requiresConfirmation = valid && hasWarning;
    return {
      homography: cloneHomography(homography),
      valid,
      statistics,
      warnings: [...homography.warnings],
      requiresConfirmation,
      warningConfirmed: this._warningConfirmed,
      canCommit: valid && (!requiresConfirmation || this._warningConfirmed),
      isRecommended: this._pairs.length >= RECOMMENDED_CALIBRATION_PAIRS,
      mask: this._manualMask ? validateManualBoardMask(this._manualMask) : null,
    };
  }

  /** Gibt die Kalibrierung als neuen Wert zurück; der Session-Draft bleibt offen. */
  commit(): PhotoCalibration {
    this._ensureOpen();
    const validation = this.getValidation();
    if (!validation.valid) {
      throw new CalibrationSessionError(validation.homography.error ?? 'Kalibrierung ist ungültig.');
    }
    if (!validation.canCommit) {
      throw new CalibrationSessionError('Die Warnung muss vor dem Speichern bestätigt werden.');
    }
    return { version: 1, points: this._pairs.map(clonePair) };
  }

  commitMask(): ManualBoardMask | null {
    this._ensureOpen();
    if (!this._manualMask) return null;
    const validation = validateManualBoardMask(this._manualMask);
    if (!validation.valid) throw new CalibrationSessionError(validation.reason ?? 'Die manuelle Maske ist ungültig.');
    return cloneMask(this._manualMask);
  }

  /** Verwirft den Draft und stellt nur die anfänglich übergebenen Daten wieder her. */
  cancel(): CalibrationSessionState {
    this._pairs = this._initialCalibration?.points.map(clonePair) ?? [];
    this._manualMask = cloneMask(this._initialMask);
    this._activePairId = this._pairs[0]?.id ?? null;
    this._pendingBoardPoint = null;
    this._warningConfirmed = false;
    this._cancelled = true;
    return this.getState();
  }

  getState(): CalibrationSessionState {
    return {
      pairs: this._pairs.map(clonePair),
      activePairId: this._activePairId,
      pendingBoardPoint: this._pendingBoardPoint ? clonePoint(this._pendingBoardPoint) : null,
      preview: this._preview,
      referenceViewport: cloneViewport(this._referenceViewport),
      photoViewport: cloneViewport(this._photoViewport),
      outlineSnap: this._outlineSnap,
      manualMask: cloneMask(this._manualMask),
      cancelled: this._cancelled,
      validation: this.getValidation(),
    };
  }

  snapshot(): CalibrationSessionState {
    return this.getState();
  }
}
