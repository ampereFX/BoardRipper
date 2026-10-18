import type { BoardData, Pad, Pin, Point } from '../parsers/types';

/** One quantization step corresponds to 0.001 board units (usually mil). */
const QUANTIZATION = 1e-3;

interface Origin {
  x: number;
  y: number;
}

function isFinitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function quantize(value: number): number {
  const result = Math.round(value / QUANTIZATION);
  return Object.is(result, -0) ? 0 : result;
}

function pointKey(point: Point, origin: Origin): string {
  return `${quantize(point.x - origin.x)},${quantize(point.y - origin.y)}`;
}

function sizeKey(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) ? null : quantize(Math.abs(value));
}

function angleKey(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const normalized = ((value % 360) + 360) % 360;
  return quantize(normalized);
}

function center(bounds: { minX: number; minY: number; maxX: number; maxY: number }): Point {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function allGeometryPoints(board: BoardData): Point[] {
  const points = board.outline.filter(isFinitePoint);

  for (const nail of board.nails) points.push(nail.position);
  for (const via of board.vias ?? []) points.push(via.position);
  for (const part of board.parts) {
    for (const pin of part.pins) {
      points.push(pin.position);
      if (pin.padBounds) {
        points.push(
          { x: pin.padBounds.minX, y: pin.padBounds.minY },
          { x: pin.padBounds.maxX, y: pin.padBounds.maxY },
        );
      }
      for (const point of pin.padPolygon ?? []) points.push(point);
    }
  }
  for (const pad of board.pads ?? []) {
    points.push(
      { x: pad.bounds.minX, y: pad.bounds.minY },
      { x: pad.bounds.maxX, y: pad.bounds.maxY },
    );
    for (const point of pad.polygon ?? []) points.push(point);
  }

  return points.filter(isFinitePoint);
}

/** The geometric minimum point is translation-stable and independent of array
 *  order. Only the differences to it are quantized. */
function geometryOrigin(board: BoardData): Origin {
  const points = allGeometryPoints(board);
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: Math.min(...points.map((point) => point.x)),
    y: Math.min(...points.map((point) => point.y)),
  };
}

function splitOutline(outline: Point[]): Point[][] {
  const contours: Point[][] = [];
  let current: Point[] = [];
  for (const point of outline) {
    if (!isFinitePoint(point)) {
      if (current.length > 0) contours.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) contours.push(current);
  return contours;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rotations(values: string[]): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < values.length; start++) {
    candidates.push([...values.slice(start), ...values.slice(0, start)].join(';'));
  }
  return candidates;
}

/** Contours are independent of start point and winding direction, but keep
 *  their segment sequence. Multiple NaN-separated contours are sorted later. */
function canonicalContour(contour: Point[], origin: Origin): string {
  const values = contour.map((point) => pointKey(point, origin));
  while (values.length > 1 && values.at(-1) === values[0]) values.pop();
  if (values.length <= 1) return values.join(';');

  const reversed = [...values].reverse();
  const candidates = [...rotations(values), ...rotations(reversed)];
  candidates.sort(compareStrings);
  return candidates[0];
}

function canonicalPolygon(points: Point[] | undefined, origin: Origin): string | null {
  if (!points || points.length === 0) return null;
  return canonicalContour(points, origin);
}

function pinDescriptor(pin: Pin, origin: Origin): string {
  const bounds = pin.padBounds;
  return JSON.stringify([
    pointKey(pin.position, origin),
    sizeKey(pin.radius * 2),
    bounds ? pointKey(center(bounds), origin) : null,
    bounds ? sizeKey(bounds.maxX - bounds.minX) : null,
    bounds ? sizeKey(bounds.maxY - bounds.minY) : null,
    pin.padShape ?? null,
    sizeKey(pin.padWidth),
    sizeKey(pin.padHeight),
    angleKey(pin.padAngleDeg),
    sizeKey(pin.padCornerRadius),
    canonicalPolygon(pin.padPolygon, origin),
  ]);
}

function padDescriptor(pad: Pad, origin: Origin): string {
  return JSON.stringify([
    pointKey(center(pad.bounds), origin),
    sizeKey(pad.bounds.maxX - pad.bounds.minX),
    sizeKey(pad.bounds.maxY - pad.bounds.minY),
    pad.shape ?? null,
    sizeKey(pad.width),
    sizeKey(pad.height),
    angleKey(pad.angleDeg),
    sizeKey(pad.cornerRadius),
    canonicalPolygon(pad.polygon, origin),
  ]);
}

/** Kanonischer, translationsnormalisierter Geometrie-Descriptor.
 *  Namen, Netze, Pfade, Formatangaben und Laufzeit-IDs werden nie gelesen. */
function canonicalDescriptor(board: BoardData): string {
  const origin = geometryOrigin(board);
  const outline = splitOutline(board.outline)
    .map((contour) => canonicalContour(contour, origin))
    .sort(compareStrings);
  const nails = board.nails
    .map((nail) => pointKey(nail.position, origin))
    .sort(compareStrings);
  const holes = [
    ...board.parts.flatMap((part) => part.pins
      .filter((pin) => pin.drill !== undefined && pin.drill > 0)
      .map((pin) => JSON.stringify([pointKey(pin.position, origin), sizeKey(pin.drill)]))),
    ...(board.pads ?? [])
      .filter((pad) => pad.drill !== undefined && pad.drill > 0)
      .map((pad) => JSON.stringify([pointKey(center(pad.bounds), origin), sizeKey(pad.drill)])),
  ].sort(compareStrings);
  const pins = board.parts
    .flatMap((part) => part.pins.map((pin) => pinDescriptor(pin, origin)))
    .sort(compareStrings);
  const pads = (board.pads ?? [])
    .map((pad) => padDescriptor(pad, origin))
    .sort(compareStrings);
  const vias = (board.vias ?? [])
    .map((via) => JSON.stringify([pointKey(via.position, origin), sizeKey(via.diameter)]))
    .sort(compareStrings);

  return JSON.stringify({ outline, nails, holes, pins, pads, vias });
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Computes the stable key of a board geometry. The occurrenceIndex
 *  distinguishes identical subboards within a pack. */
export async function computeSubboardKey(board: BoardData, occurrenceIndex = 0): Promise<string> {
  if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
    throw new RangeError('The occurrence index must be a non-negative integer.');
  }
  const digest = await sha256Hex(canonicalDescriptor(board));
  return `${digest}#${occurrenceIndex}`;
}

interface PackEntry {
  index: number;
  digest: string;
  placement: [number, number, number, number];
}

function packOrigin(boards: BoardData[]): Origin {
  const finiteBounds = boards
    .map((board) => board.bounds)
    .filter((bounds) => Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY));
  if (finiteBounds.length === 0) return { x: 0, y: 0 };
  return {
    x: Math.min(...finiteBounds.map((bounds) => bounds.minX)),
    y: Math.min(...finiteBounds.map((bounds) => bounds.minY)),
  };
}

/** The pack placement is derived exclusively from the absolute board bounds.
 *  The shared pack origin shift makes it translation-stable. */
function boardPlacement(board: BoardData, origin: Origin): [number, number, number, number] {
  const { minX, minY, maxX, maxY } = board.bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
  return [
    quantize(minX - origin.x),
    quantize(minY - origin.y),
    quantize(maxX - minX),
    quantize(maxY - minY),
  ];
}

function comparePlacements(a: PackEntry, b: PackEntry): number {
  for (let index = 0; index < a.placement.length; index++) {
    if (a.placement[index] !== b.placement[index]) {
      return a.placement[index] < b.placement[index] ? -1 : 1;
    }
  }
  // Exactly coincident duplicates are geometrically indistinguishable.
  // The input index is only a deterministic tie-breaker for that case;
  // names, nets, paths and runtime IDs are deliberately not used.
  return a.index - b.index;
}

/** Assigns occurrence indices per fingerprint based on the pack geometry. */
export async function computeSubboardKeys(boards: BoardData[]): Promise<string[]> {
  const descriptors = boards.map(canonicalDescriptor);
  const digests = await Promise.all(descriptors.map(sha256Hex));
  const origin = packOrigin(boards);
  const entries: PackEntry[] = boards.map((board, index) => ({
    index,
    digest: digests[index],
    placement: boardPlacement(board, origin),
  }));
  const occurrences = new Map<string, number>();
  const keys = new Array<string>(boards.length);

  entries.sort((a, b) => {
    const digestOrder = compareStrings(a.digest, b.digest);
    return digestOrder !== 0 ? digestOrder : comparePlacements(a, b);
  });
  for (const entry of entries) {
    const occurrence = occurrences.get(entry.digest) ?? 0;
    occurrences.set(entry.digest, occurrence + 1);
    keys[entry.index] = `${entry.digest}#${occurrence}`;
  }
  return keys;
}
