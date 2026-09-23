import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import type { BoardData, BBox, Part, Pin, Point } from '../../parsers/types';
import {
  CalibrationSession,
  CalibrationSessionError,
  type CalibrationPreviewMode,
} from '../../photo-overlay/calibration-session';
import { applyHomography } from '../../photo-overlay/homography';
import type { BoardDimensions } from '../../photo-overlay/homography';
import type {
  CalibrationPointPair,
  ManualBoardMask,
  NormalizedPoint,
  PhotoCalibration,
} from '../../photo-overlay/types';
import { normalizePhotoImage } from './ImageNormalization';
import './photo-overlay.css';

const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 400;
const MARKER_HIT_DISTANCE = 0.035;

export interface CalibrationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CalibrationBoardComponent {
  label: string;
  bounds: CalibrationRect;
  pins?: ReadonlyArray<NormalizedPoint>;
}

/** Kleine, bereits normalisierte Renderansicht. Sie hält den Dialog frei von
 *  Parser- und Store-Details und ist deshalb auch für Tests leicht nutzbar. */
export interface CalibrationBoardViewModel {
  outline: ReadonlyArray<NormalizedPoint>;
  outlinePaths?: ReadonlyArray<ReadonlyArray<NormalizedPoint>>;
  outlineReliable?: boolean;
  holes?: ReadonlyArray<NormalizedPoint>;
  vias?: ReadonlyArray<NormalizedPoint>;
  pads?: ReadonlyArray<CalibrationRect>;
  components?: ReadonlyArray<CalibrationBoardComponent>;
}

export type CalibrationBoardSource = CalibrationBoardViewModel | BoardData;
export type CalibrationDialogMode = 'import' | 'recalibrate';

export interface CalibrationImportResult {
  mode: 'import';
  photoBlob: Blob;
  calibration: PhotoCalibration;
  manualMask: ManualBoardMask | null;
}

export interface CalibrationRecalibrationResult {
  mode: 'recalibrate';
  calibration: PhotoCalibration;
  manualMask: ManualBoardMask | null;
}

export type CalibrationDialogResult = CalibrationImportResult | CalibrationRecalibrationResult;

export interface CalibrationDialogProps {
  board: CalibrationBoardSource;
  imageBlob?: Blob | null;
  mode?: CalibrationDialogMode;
  initialCalibration?: PhotoCalibration | null;
  initialMask?: ManualBoardMask | null;
  boardDimensions?: BoardDimensions;
  onSave: (result: CalibrationDialogResult) => void;
  onCancel: () => void;
}

interface DragState {
  view: 'reference' | 'photo';
  kind: 'pair' | 'mask' | 'pan';
  id?: number;
  maskIndex?: number;
  point: NormalizedPoint;
}

function clampPoint(point: NormalizedPoint): NormalizedPoint {
  return { x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) };
}

function normalizePoint(point: Point, bounds: BBox): NormalizedPoint {
  return {
    x: bounds.maxX === bounds.minX ? 0.5 : (point.x - bounds.minX) / (bounds.maxX - bounds.minX),
    y: bounds.maxY === bounds.minY ? 0.5 : (point.y - bounds.minY) / (bounds.maxY - bounds.minY),
  };
}

function normalizeRect(bounds: BBox, boardBounds: BBox): CalibrationRect {
  const topLeft = normalizePoint({ x: bounds.minX, y: bounds.minY }, boardBounds);
  const bottomRight = normalizePoint({ x: bounds.maxX, y: bounds.maxY }, boardBounds);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

function deriveBoardBounds(board: BoardData): BBox {
  if (Number.isFinite(board.bounds.minX) && Number.isFinite(board.bounds.maxX)
    && Number.isFinite(board.bounds.minY) && Number.isFinite(board.bounds.maxY)) {
    return board.bounds;
  }
  const points = board.outline.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs, 0),
    minY: Math.min(...ys, 0),
    maxX: Math.max(...xs, 1),
    maxY: Math.max(...ys, 1),
  };
}

function pinPosition(pin: Pin, bounds: BBox): NormalizedPoint {
  return normalizePoint(pin.position, bounds);
}

/** Adapter für die bestehende BoardData, ohne den Dialog an einen Store zu binden. */
// The adapter is exported with the dialog types so callers can pass a normal
// BoardData without coupling their code to a separate view-model builder.
// eslint-disable-next-line react-refresh/only-export-components
export function boardDataToCalibrationView(board: BoardData): CalibrationBoardViewModel {
  const bounds = deriveBoardBounds(board);
  const paths: NormalizedPoint[][] = [];
  let path: NormalizedPoint[] = [];
  for (const point of board.outline) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      if (path.length > 0) paths.push(path);
      path = [];
    } else {
      path.push(normalizePoint(point, bounds));
    }
  }
  if (path.length > 0) paths.push(path);

  const holes = board.pads?.filter((pad) => pad.drill !== undefined)
    .map((pad) => normalizePoint({
      x: (pad.bounds.minX + pad.bounds.maxX) / 2,
      y: (pad.bounds.minY + pad.bounds.maxY) / 2,
    }, bounds)) ?? [];
  const pinsWithDrill = board.parts.flatMap((part) => part.pins.filter((pin) => pin.drill !== undefined)
    .map((pin) => pinPosition(pin, bounds)));
  const components = board.parts
    .filter((part) => !part.hidden)
    .map((part: Part): CalibrationBoardComponent => ({
      label: part.name,
      bounds: normalizeRect(part.bounds, bounds),
      pins: part.pins.map((pin) => pinPosition(pin, bounds)),
    }));

  return {
    outline: paths[0] ?? [],
    outlinePaths: paths,
    outlineReliable: paths.some((candidate) => candidate.length >= 3),
    holes: [...holes, ...pinsWithDrill],
    vias: board.vias?.map((via) => normalizePoint(via.position, bounds)) ?? [],
    pads: board.pads?.map((pad) => normalizeRect(pad.bounds, bounds)) ?? [],
    components,
  };
}

function toViewModel(board: CalibrationBoardSource): CalibrationBoardViewModel {
  return 'format' in board ? boardDataToCalibrationView(board) : board;
}

function distance(a: NormalizedPoint, b: NormalizedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function viewToCanvas(point: NormalizedPoint, zoom: number, pan: NormalizedPoint): { x: number; y: number } {
  return {
    x: (0.5 + (point.x - 0.5) * zoom + pan.x) * CANVAS_WIDTH,
    y: (0.5 + (point.y - 0.5) * zoom + pan.y) * CANVAS_HEIGHT,
  };
}

function canvasToView(event: ReactPointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement, zoom: number, pan: NormalizedPoint): NormalizedPoint {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || CANVAS_WIDTH;
  const height = rect.height || CANVAS_HEIGHT;
  const canvasX = (event.clientX - rect.left) / width;
  const canvasY = (event.clientY - rect.top) / height;
  return clampPoint({
    x: 0.5 + (canvasX - 0.5 - pan.x) / zoom,
    y: 0.5 + (canvasY - 0.5 - pan.y) / zoom,
  });
}

function drawPoint(context: CanvasRenderingContext2D, point: NormalizedPoint, zoom: number, pan: NormalizedPoint, color: string, radius = 5): void {
  const canvasPoint = viewToCanvas(point, zoom, pan);
  context.beginPath();
  context.arc(canvasPoint.x, canvasPoint.y, radius, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
}

function transformPoint(point: NormalizedPoint, matrix: number[] | null): NormalizedPoint | null {
  if (!matrix) return point;
  try {
    return clampPoint(applyHomography(matrix, point));
  } catch {
    return null;
  }
}

function drawBoard(
  context: CanvasRenderingContext2D,
  board: CalibrationBoardViewModel,
  zoom: number,
  pan: NormalizedPoint,
  matrix: number[] | null = null,
  alpha = 1,
): void {
  const map = (point: NormalizedPoint): NormalizedPoint | null => transformPoint(point, matrix);
  context.save();
  context.globalAlpha = alpha;
  const paths = board.outlinePaths?.length ? board.outlinePaths : [board.outline];
  context.strokeStyle = '#52a8ff';
  context.lineWidth = 3;
  for (const path of paths) {
    const first = map(path[0]);
    if (!first) continue;
    const start = viewToCanvas(first, zoom, pan);
    context.beginPath();
    context.moveTo(start.x, start.y);
    for (const point of path.slice(1)) {
      const mapped = map(point);
      if (mapped) {
        const canvasPoint = viewToCanvas(mapped, zoom, pan);
        context.lineTo(canvasPoint.x, canvasPoint.y);
      }
    }
    context.closePath();
    context.stroke();
  }

  context.fillStyle = 'rgba(90, 160, 255, 0.22)';
  for (const pad of board.pads ?? []) {
    const corners = [
      { x: pad.x, y: pad.y },
      { x: pad.x + pad.width, y: pad.y },
      { x: pad.x + pad.width, y: pad.y + pad.height },
      { x: pad.x, y: pad.y + pad.height },
    ].map(map).filter((point): point is NormalizedPoint => point !== null);
    if (corners.length < 4) continue;
    const first = viewToCanvas(corners[0], zoom, pan);
    context.beginPath();
    context.moveTo(first.x, first.y);
    for (const point of corners.slice(1)) {
      const canvasPoint = viewToCanvas(point, zoom, pan);
      context.lineTo(canvasPoint.x, canvasPoint.y);
    }
    context.closePath();
    context.fill();
  }

  for (const component of board.components ?? []) {
    const corners = [
      { x: component.bounds.x, y: component.bounds.y },
      { x: component.bounds.x + component.bounds.width, y: component.bounds.y },
      { x: component.bounds.x + component.bounds.width, y: component.bounds.y + component.bounds.height },
      { x: component.bounds.x, y: component.bounds.y + component.bounds.height },
    ].map(map).filter((point): point is NormalizedPoint => point !== null);
    if (corners.length === 4) {
      const first = viewToCanvas(corners[0], zoom, pan);
      context.beginPath();
      context.moveTo(first.x, first.y);
      for (const point of corners.slice(1)) {
        const canvasPoint = viewToCanvas(point, zoom, pan);
        context.lineTo(canvasPoint.x, canvasPoint.y);
      }
      context.closePath();
      context.strokeStyle = '#f1bd58';
      context.lineWidth = 1.5;
      context.stroke();
      const labelPoint = viewToCanvas(map({ x: component.bounds.x, y: component.bounds.y })!, zoom, pan);
      context.fillStyle = '#f7d58b';
      context.font = '11px sans-serif';
      context.fillText(component.label, labelPoint.x + 3, labelPoint.y - 3);
    }
    for (const pin of component.pins ?? []) {
      const mapped = map(pin);
      if (mapped) drawPoint(context, mapped, zoom, pan, '#e9f2ff', 2.5);
    }
  }
  for (const hole of [...(board.holes ?? []), ...(board.vias ?? [])]) {
    const mapped = map(hole);
    if (mapped) drawPoint(context, mapped, zoom, pan, '#d5d5d5', 4);
  }
  context.restore();
}

function drawPhoto(context: CanvasRenderingContext2D, image: HTMLImageElement | null, zoom: number, pan: NormalizedPoint): void {
  if (!image || image.naturalWidth === 0) return;
  context.save();
  const center = viewToCanvas({ x: 0.5, y: 0.5 }, 1, pan);
  context.translate(center.x, center.y);
  context.scale(zoom, zoom);
  context.translate(-CANVAS_WIDTH / 2, -CANVAS_HEIGHT / 2);
  context.globalAlpha = 1;
  context.drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  context.restore();
}

function drawMask(context: CanvasRenderingContext2D, mask: ManualBoardMask | null, zoom: number, pan: NormalizedPoint, selectedIndex: number | null): void {
  if (!mask || mask.points.length === 0) return;
  context.save();
  context.strokeStyle = '#ffbd4a';
  context.fillStyle = 'rgba(255, 189, 74, 0.15)';
  context.lineWidth = 2;
  context.beginPath();
  mask.points.forEach((point, index) => {
    const canvasPoint = viewToCanvas(point, zoom, pan);
    if (index === 0) context.moveTo(canvasPoint.x, canvasPoint.y);
    else context.lineTo(canvasPoint.x, canvasPoint.y);
  });
  if (mask.points.length >= 3) context.closePath();
  context.fill();
  context.stroke();
  mask.points.forEach((point, index) => drawPoint(context, point, zoom, pan, index === selectedIndex ? '#ffffff' : '#ffbd4a', index === selectedIndex ? 7 : 5));
  context.restore();
}

function pairHit(pairs: CalibrationPointPair[], point: NormalizedPoint, view: 'reference' | 'photo', zoom: number): CalibrationPointPair | null {
  return pairs.find((pair) => distance(view === 'reference' ? pair.board : pair.photo, point) <= MARKER_HIT_DISTANCE / zoom) ?? null;
}

function maskHit(mask: ManualBoardMask | null, point: NormalizedPoint, zoom: number): number | null {
  if (!mask) return null;
  const index = mask.points.findIndex((candidate) => distance(candidate, point) <= MARKER_HIT_DISTANCE / zoom);
  return index < 0 ? null : index;
}

function viewportCenter(point: NormalizedPoint, zoom: number): NormalizedPoint {
  return { x: -(point.x - 0.5) * zoom, y: -(point.y - 0.5) * zoom };
}

function capturePointer(canvas: HTMLCanvasElement, pointerId: number): void {
  if (typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(pointerId);
}

export function CalibrationDialog({
  board,
  imageBlob = null,
  mode = 'import',
  initialCalibration = null,
  initialMask = null,
  boardDimensions,
  onSave,
  onCancel,
}: CalibrationDialogProps) {
  const boardView = useMemo(() => toViewModel(board), [board]);
  const session = useMemo(() => new CalibrationSession({
    boardDimensions,
    initialCalibration,
    initialMask,
    boardOutline: boardView.outlineReliable === false ? [] : boardView.outline,
  }), [boardDimensions, boardView, initialCalibration, initialMask]);
  const [sessionState, setSessionState] = useState(() => session.getState());
  const [maskMode, setMaskMode] = useState(boardView.outlineReliable === false);
  const [selectedMaskIndex, setSelectedMaskIndex] = useState<number | null>(null);
  const [normalizedImage, setNormalizedImage] = useState<Blob | null>(mode === 'recalibrate' ? imageBlob : null);
  const [normalizationError, setNormalizationError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [photoImage, setPhotoImage] = useState<HTMLImageElement | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const referenceCanvasRef = useRef<HTMLCanvasElement>(null);
  const photoCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  const refresh = (): void => setSessionState(session.getState());

  useEffect(() => {
    let disposed = false;
    setNormalizationError(null);
    if (!imageBlob) {
      setNormalizedImage(null);
      return () => { disposed = true; };
    }
    if (mode === 'recalibrate') {
      setNormalizedImage(imageBlob);
      return () => { disposed = true; };
    }
    setNormalizedImage(null);
    void normalizePhotoImage(imageBlob).then((result) => {
      if (!disposed) setNormalizedImage(result.blob);
    }).catch((error: unknown) => {
      if (!disposed) setNormalizationError(error instanceof Error ? error.message : 'Das Bild konnte nicht normalisiert werden.');
    });
    return () => { disposed = true; };
  }, [imageBlob, mode]);

  useEffect(() => {
    if (!normalizedImage) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(normalizedImage);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setPreviewUrl(null);
    };
  }, [normalizedImage]);

  useEffect(() => {
    if (!previewUrl) {
      setPhotoImage(null);
      return;
    }
    const image = new Image();
    const loaded = (): void => setPhotoImage(image);
    image.addEventListener('load', loaded);
    image.src = previewUrl;
    return () => {
      image.removeEventListener('load', loaded);
      image.src = '';
    };
  }, [previewUrl]);

  useEffect(() => {
    const canvases = [referenceCanvasRef.current, photoCanvasRef.current, previewCanvasRef.current];
    canvases.forEach((canvas) => {
      if (canvas) {
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;
      }
    });
    const drawCanvas = (
      canvas: HTMLCanvasElement | null,
      view: 'reference' | 'photo',
      previewMode?: CalibrationPreviewMode,
    ): void => {
      const context = canvas?.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      context.fillStyle = '#080b12';
      context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      const viewport = view === 'reference' ? sessionState.referenceViewport : sessionState.photoViewport;
      if (previewMode === 'photo') drawPhoto(context, photoImage, viewport.zoom, viewport.pan);
      else if (previewMode === 'compare') {
        drawPhoto(context, photoImage, viewport.zoom, viewport.pan);
        drawBoard(context, boardView, viewport.zoom, viewport.pan, sessionState.validation.homography.matrix, 0.62);
      } else if (previewMode === 'reference') {
        drawBoard(context, boardView, viewport.zoom, viewport.pan);
      } else {
        if (view === 'photo') drawPhoto(context, photoImage, viewport.zoom, viewport.pan);
        else drawBoard(context, boardView, viewport.zoom, viewport.pan);
      }
      if (view === 'reference' && !previewMode) drawMask(context, sessionState.manualMask, viewport.zoom, viewport.pan, selectedMaskIndex);
      if (!previewMode) {
        sessionState.pairs.forEach((pair) => {
          const point = view === 'reference' ? pair.board : pair.photo;
          drawPoint(context, point, viewport.zoom, viewport.pan, pair.id === sessionState.activePairId ? '#ffffff' : '#ff5c7a', pair.id === sessionState.activePairId ? 8 : 6);
          const canvasPoint = viewToCanvas(point, viewport.zoom, viewport.pan);
          context.fillStyle = '#11151f';
          context.font = 'bold 11px sans-serif';
          context.fillText(String(sessionState.pairs.findIndex((candidate) => candidate.id === pair.id) + 1), canvasPoint.x + 8, canvasPoint.y + 4);
        });
        if (view === 'reference' && sessionState.pendingBoardPoint) drawPoint(context, sessionState.pendingBoardPoint, viewport.zoom, viewport.pan, '#ffbd4a', 8);
      }
    };
    drawCanvas(referenceCanvasRef.current, 'reference');
    drawCanvas(photoCanvasRef.current, 'photo');
    drawCanvas(previewCanvasRef.current, 'photo', sessionState.preview);
  }, [boardView, photoImage, selectedMaskIndex, sessionState]);

  const centerPair = (pair: CalibrationPointPair): void => {
    session.setPan('reference', viewportCenter(pair.board, sessionState.referenceViewport.zoom));
    session.setPan('photo', viewportCenter(pair.photo, sessionState.photoViewport.zoom));
    refresh();
  };

  const selectPair = (pair: CalibrationPointPair): void => {
    session.selectPair(pair.id);
    centerPair(pair);
  };

  const handlePointerDown = (view: 'reference' | 'photo', event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const viewport = view === 'reference' ? sessionState.referenceViewport : sessionState.photoViewport;
    const point = canvasToView(event, event.currentTarget, viewport.zoom, viewport.pan);

    if (maskMode) {
      if (view === 'reference') {
        const hitMask = maskHit(sessionState.manualMask, point, viewport.zoom);
        if (hitMask !== null) {
          setSelectedMaskIndex(hitMask);
          dragRef.current = { view, kind: 'mask', maskIndex: hitMask, point };
        } else {
          session.addManualMaskPoint(point);
          const nextMask = session.getState().manualMask;
          setSelectedMaskIndex(nextMask && nextMask.points.length > 0 ? nextMask.points.length - 1 : null);
        }
        refresh();
        capturePointer(event.currentTarget, event.pointerId);
      } else if (event.button === 1 || event.altKey || event.shiftKey) {
        dragRef.current = { view, kind: 'pan', point };
        capturePointer(event.currentTarget, event.pointerId);
      }
      return;
    }

    const hit = pairHit(sessionState.pairs, point, view, viewport.zoom);
    if (hit) {
      session.selectPair(hit.id);
      centerPair(hit);
      dragRef.current = { view, kind: 'pair', id: hit.id, point };
      capturePointer(event.currentTarget, event.pointerId);
      return;
    }
    if (event.button === 1 || event.altKey || event.shiftKey) {
      dragRef.current = { view, kind: 'pan', point };
      capturePointer(event.currentTarget, event.pointerId);
      return;
    }
    try {
      if (view === 'reference') session.addBoardPoint(point);
      else if (sessionState.pendingBoardPoint) session.addPhotoPoint(point);
      else throw new CalibrationSessionError('Zuerst muss der Boardpunkt gesetzt werden.');
      refresh();
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : 'Der Punkt konnte nicht gesetzt werden.');
    }
  };

  const handlePointerMove = (view: 'reference' | 'photo', event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.view !== view) return;
    const viewport = view === 'reference' ? sessionState.referenceViewport : sessionState.photoViewport;
    const point = canvasToView(event, event.currentTarget, viewport.zoom, viewport.pan);
    try {
      if (drag.kind === 'pair' && drag.id !== undefined) {
        if (view === 'reference') session.moveBoardPoint(drag.id, point);
        else session.movePhotoPoint(drag.id, point);
      } else if (drag.kind === 'mask' && drag.maskIndex !== undefined) {
        session.moveManualMaskPoint(drag.maskIndex, point);
      } else if (drag.kind === 'pan') {
        const delta = { x: (point.x - drag.point.x) * viewport.zoom, y: (point.y - drag.point.y) * viewport.zoom };
        session.panBy(view, delta);
        drag.point = point;
      }
      refresh();
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : 'Die Position konnte nicht geändert werden.');
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    dragRef.current = null;
    if (typeof event.currentTarget.hasPointerCapture === 'function'
      && event.currentTarget.hasPointerCapture(event.pointerId)
      && typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleWheel = (view: 'reference' | 'photo', event: ReactWheelEvent<HTMLCanvasElement>): void => {
    event.preventDefault();
    session.zoomBy(view, event.deltaY < 0 ? 1.15 : 1 / 1.15);
    refresh();
  };

  const deleteActivePair = (): void => {
    if (sessionState.activePairId === null) return;
    try {
      session.deletePair(sessionState.activePairId);
      refresh();
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : 'Das Paar konnte nicht gelöscht werden.');
    }
  };

  const deleteSelectedMaskPoint = (): void => {
    if (selectedMaskIndex === null) return;
    try {
      session.deleteManualMaskPoint(selectedMaskIndex);
      setSelectedMaskIndex(null);
      refresh();
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : 'Der Maskenpunkt konnte nicht gelöscht werden.');
    }
  };

  const cancel = (): void => {
    session.cancel();
    onCancel();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel();
      if (event.key === 'Delete' && document.activeElement?.tagName !== 'INPUT') {
        if (maskMode && selectedMaskIndex !== null) deleteSelectedMaskPoint();
        else deleteActivePair();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const setPreview = (preview: CalibrationPreviewMode): void => {
    session.setPreview(preview);
    refresh();
  };

  const toggleMaskMode = (): void => {
    const next = !maskMode;
    if (next) session.clearPendingBoardPoint();
    setMaskMode(next);
    refresh();
  };

  const save = (): void => {
    setActionError(null);
    try {
      const calibration = session.commit();
      if (boardView.outlineReliable === false && !sessionState.validation.mask?.valid) {
        throw new CalibrationSessionError('Ohne verlässliche Outline ist eine gültige manuelle Boardmaske erforderlich.');
      }
      const manualMask = session.commitMask();
      if (mode === 'import') {
        if (!normalizedImage) throw new CalibrationSessionError('Das Bild wird noch normalisiert.');
        onSave({ mode: 'import', photoBlob: normalizedImage, calibration, manualMask });
      } else {
        onSave({ mode: 'recalibrate', calibration, manualMask });
      }
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : 'Die Kalibrierung konnte nicht gespeichert werden.');
    }
  };

  const validation = sessionState.validation;
  const canSave = validation.canCommit
    && sessionState.pairs.length >= 4
    && (mode === 'recalibrate' || normalizedImage !== null)
    && (!normalizationError)
    && (boardView.outlineReliable !== false || validation.mask?.valid === true);

  return (
    <div className="photo-overlay-calibration" role="dialog" aria-modal="true" aria-labelledby="photo-overlay-calibration-title" data-testid="photo-overlay-calibration-dialog">
      <div className="photo-overlay-calibration__header">
        <div>
          <h2 id="photo-overlay-calibration-title">Foto-Overlay kalibrieren</h2>
          <p>Setze pro Paar zuerst einen Boardpunkt und danach den identischen Punkt im Foto.</p>
        </div>
        <button type="button" className="photo-overlay-calibration__close" onClick={cancel} aria-label="Kalibrierung abbrechen">×</button>
      </div>

      <div className="photo-overlay-calibration__toolbar">
        <span data-testid="photo-overlay-calibration-count">{sessionState.pairs.length}/12 Paare</span>
        {sessionState.pairs.length > 0 && sessionState.pairs.length < 6 && <span className="photo-overlay-calibration__hint">Mindestens 6 Paare werden empfohlen.</span>}
        {boardView.outlineReliable !== false && (
          <label><input type="checkbox" checked={sessionState.outlineSnap} onChange={(event) => { session.setOutlineSnap(event.currentTarget.checked); refresh(); }} /> Outline-Snap</label>
        )}
        <button type="button" onClick={toggleMaskMode} data-testid="photo-overlay-manual-mask-mode">
          {maskMode ? 'Maskenmodus beenden' : 'Manuelle Boardmaske'}
        </button>
        {maskMode && <span className="photo-overlay-calibration__hint">Punkte in der Boardansicht setzen; mindestens 3 Randpunkte in lokalen Boardkoordinaten.</span>}
        {maskMode && <span data-testid="photo-overlay-manual-mask-points">{sessionState.manualMask?.points.length ?? 0} Maskenpunkte</span>}
      </div>

      {normalizationError && <p className="photo-overlay-calibration__error" role="alert">{normalizationError}</p>}
      {actionError && <p className="photo-overlay-calibration__error" role="alert">{actionError}</p>}

      <div className="photo-overlay-calibration__workbench">
        <section className="photo-overlay-calibration__view-section">
          <h3>Boardansicht</h3>
          <p className="photo-overlay-calibration__instruction">{maskMode ? 'Maskenpunkte in lokalen Boardkoordinaten setzen, ziehen oder auswählen.' : sessionState.pendingBoardPoint ? 'Jetzt den identischen Punkt im Foto setzen.' : 'Boardpunkt setzen oder Marker ziehen.'}</p>
          <canvas
            ref={referenceCanvasRef}
            className="photo-overlay-calibration__canvas"
            data-testid="photo-overlay-reference-canvas"
            aria-label={maskMode ? 'Boardansicht für manuelle Boardmaske; Maskenpunkte setzen und bearbeiten' : 'Boardansicht mit Outline, Bohrungen, Vias, Pads und Komponenten'}
            onPointerDown={(event) => handlePointerDown('reference', event)}
            onPointerMove={(event) => handlePointerMove('reference', event)}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={(event) => handleWheel('reference', event)}
          />
          <div className="photo-overlay-calibration__viewport-controls">
            <button type="button" onClick={() => { session.zoomBy('reference', 1.2); refresh(); }}>Board +</button>
            <button type="button" onClick={() => { session.zoomBy('reference', 1 / 1.2); refresh(); }}>Board −</button>
          </div>
        </section>
        <section className="photo-overlay-calibration__view-section">
          <h3>Fotoansicht</h3>
          <p className="photo-overlay-calibration__instruction">{maskMode ? 'Maskenmodus: Fotoansicht ohne Maskenbearbeitung.' : 'Fotopunkt setzen oder Marker ziehen.'}</p>
          <canvas
            ref={photoCanvasRef}
            className="photo-overlay-calibration__canvas"
            data-testid="photo-overlay-photo-canvas"
            aria-label={maskMode ? 'Fotoansicht ohne Maskenbearbeitung im Maskenmodus' : 'Fotoansicht mit Kalibrierungsmarkern'}
            onPointerDown={(event) => handlePointerDown('photo', event)}
            onPointerMove={(event) => handlePointerMove('photo', event)}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={(event) => handleWheel('photo', event)}
          />
          <div className="photo-overlay-calibration__viewport-controls">
            <button type="button" onClick={() => { session.zoomBy('photo', 1.2); refresh(); }}>Foto +</button>
            <button type="button" onClick={() => { session.zoomBy('photo', 1 / 1.2); refresh(); }}>Foto −</button>
          </div>
        </section>
      </div>

      <section className="photo-overlay-calibration__pairs" aria-label="Kalibrierpunkt-Paare">
        <div className="photo-overlay-calibration__pairs-header">
          <h3>Aktive Paare</h3>
          <button type="button" onClick={maskMode ? deleteSelectedMaskPoint : deleteActivePair} disabled={maskMode ? selectedMaskIndex === null : sessionState.activePairId === null} data-testid="photo-overlay-delete-selection">Auswahl löschen</button>
        </div>
        {sessionState.pairs.length === 0 ? <p>Noch keine Paare gesetzt.</p> : (
          <ol>
            {sessionState.pairs.map((pair, index) => (
              <li key={pair.id}>
                <button type="button" className={pair.id === sessionState.activePairId ? 'is-active' : ''} onClick={() => selectPair(pair)} data-testid={`photo-overlay-calibration-pair-${index + 1}`} aria-current={pair.id === sessionState.activePairId ? 'true' : undefined}>
                  Paar {index + 1}: Board {pair.board.x.toFixed(3)}, {pair.board.y.toFixed(3)} · Foto {pair.photo.x.toFixed(3)}, {pair.photo.y.toFixed(3)}
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      {sessionState.pairs.length >= 4 && (
        <section className="photo-overlay-calibration__preview" aria-label="Live-Vorschau">
          <div className="photo-overlay-calibration__preview-header">
            <h3>Live-Vorschau</h3>
            <div className="photo-overlay-calibration__mode-buttons">
              {(['reference', 'photo', 'compare'] as CalibrationPreviewMode[]).map((preview) => (
                <button type="button" key={preview} className={sessionState.preview === preview ? 'is-active' : ''} onClick={() => setPreview(preview)} data-testid={`photo-overlay-preview-mode-${preview}`}>
                  {preview === 'reference' ? 'Referenz' : preview === 'photo' ? 'Foto' : 'Vergleich'}
                </button>
              ))}
            </div>
          </div>
          <canvas ref={previewCanvasRef} className="photo-overlay-calibration__preview-canvas" data-testid="photo-overlay-calibration-preview" aria-label="Live-Ausrichtungsvorschau" />
        </section>
      )}

      <div className="photo-overlay-calibration__status" aria-live="polite">
        {validation.statistics && <span>RMS {((validation.statistics.rmsError) * 100).toFixed(2)} % · Max {((validation.statistics.maxError) * 100).toFixed(2)} %</span>}
        {validation.warnings.map((warning) => <span key={warning} className="photo-overlay-calibration__warning">{warning}</span>)}
        {validation.requiresConfirmation && !validation.warningConfirmed && <button type="button" onClick={() => { session.confirmWarning(); refresh(); }} data-testid="photo-overlay-confirm-warning">Warnung bestätigen</button>}
        {boardView.outlineReliable === false && <span className={validation.mask?.valid ? '' : 'photo-overlay-calibration__warning'}>{validation.mask?.valid ? 'Manuelle Boardmaske gültig.' : 'Manuelle Boardmaske: mindestens 3 gültige Randpunkte setzen.'}</span>}
      </div>

      <footer className="photo-overlay-calibration__footer">
        <button type="button" onClick={cancel}>Abbrechen</button>
        <button type="button" className="is-primary" onClick={save} disabled={!canSave} data-testid="photo-overlay-calibration-save">Speichern</button>
      </footer>
    </div>
  );
}
