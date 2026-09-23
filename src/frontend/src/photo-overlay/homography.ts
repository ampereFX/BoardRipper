import type { CalibrationPointPair, HomographyResult } from './types';

const MIN_PAIRS = 4;
const MAX_PAIRS = 12;
const MIN_SEPARATION = 1e-6;
const COLLINEAR_ERROR_RATIO = 1e-10;
const COLLINEAR_WARNING_RATIO = 1e-4;
const RANK_ERROR_RATIO = 1e-12;
const RANK_WARNING_RATIO = 1e-7;
const MATRIX_EPSILON = 1e-12;
const WARNING_THRESHOLD = 0.0075;

interface PointLike {
  x: number;
  y: number;
}

/** Physische Boardabmessungen für die Reprojektionsfehler-Metrik. */
export interface BoardDimensions {
  width: number;
  height: number;
}

interface NormalizedPoints {
  points: PointLike[];
  transform: number[];
}

function errorResult(error: string, warnings: string[] = []): HomographyResult {
  return {
    matrix: null,
    status: 'error',
    rmsError: null,
    maxError: null,
    warnings,
    error,
  };
}

function distanceSquared(a: PointLike, b: PointLike): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function normalizePoints(points: PointLike[]): NormalizedPoints | null {
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  center.x /= points.length;
  center.y /= points.length;

  const meanDistance = points.reduce(
    (sum, point) => sum + Math.hypot(point.x - center.x, point.y - center.y),
    0,
  ) / points.length;
  if (meanDistance <= MATRIX_EPSILON) return null;

  const scale = Math.SQRT2 / meanDistance;
  return {
    points: points.map((point) => ({
      x: (point.x - center.x) * scale,
      y: (point.y - center.y) * scale,
    })),
    transform: [
      scale, 0, -scale * center.x,
      0, scale, -scale * center.y,
      0, 0, 1,
    ],
  };
}

/** Verhältnis der kleineren zur größeren Hauptachsvarianz. Null bedeutet,
 *  dass alle Punkte auf einer Geraden liegen. */
function spreadRatio(points: PointLike[]): number {
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    xx += point.x * point.x;
    xy += point.x * point.y;
    yy += point.y * point.y;
  }
  const trace = xx + yy;
  const discriminant = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy));
  const largest = (trace + discriminant) / 2;
  const smallest = (trace - discriminant) / 2;
  return largest <= MATRIX_EPSILON ? 0 : Math.max(0, smallest / largest);
}

function multiply3(left: number[], right: number[]): number[] {
  const result = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      for (let inner = 0; inner < 3; inner++) {
        result[row * 3 + column] += left[row * 3 + inner] * right[inner * 3 + column];
      }
    }
  }
  return result;
}

function invertSimilarity(matrix: number[]): number[] {
  const scale = matrix[0];
  return [
    1 / scale, 0, -matrix[2] / scale,
    0, 1 / scale, -matrix[5] / scale,
    0, 0, 1,
  ];
}

function determinant3(matrix: number[]): number {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

function normalizeMatrixScale(matrix: number[]): number[] | null {
  let pivot = 0;
  for (let index = 1; index < matrix.length; index++) {
    if (Math.abs(matrix[index]) > Math.abs(matrix[pivot])) pivot = index;
  }
  const scale = matrix[pivot];
  if (!Number.isFinite(scale) || Math.abs(scale) <= MATRIX_EPSILON) return null;
  return matrix.map((value) => value / scale);
}

/** Jacobi-Eigenwertverfahren für eine kleine reelle symmetrische Matrix.
 *  Die Eigenvektoren stehen spaltenweise in vectors. */
function symmetricEigen(matrix: number[][]): { values: number[]; vectors: number[][] } {
  const size = matrix.length;
  const valuesMatrix = matrix.map((row) => [...row]);
  const vectors: number[][] = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => row === column ? 1 : 0),
  );

  for (let iteration = 0; iteration < size * size * 100; iteration++) {
    let p = 0;
    let q = 1;
    let largest = 0;
    for (let row = 0; row < size; row++) {
      for (let column = row + 1; column < size; column++) {
        const candidate = Math.abs(valuesMatrix[row][column]);
        if (candidate > largest) {
          largest = candidate;
          p = row;
          q = column;
        }
      }
    }

    const diagonalScale = Math.max(1, ...valuesMatrix.map((row, index) => Math.abs(row[index])));
    if (largest <= Number.EPSILON * diagonalScale * 10) break;

    const app = valuesMatrix[p][p];
    const aqq = valuesMatrix[q][q];
    const apq = valuesMatrix[p][q];
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    for (let index = 0; index < size; index++) {
      if (index === p || index === q) continue;
      const aip = valuesMatrix[index][p];
      const aiq = valuesMatrix[index][q];
      valuesMatrix[index][p] = cosine * aip - sine * aiq;
      valuesMatrix[p][index] = valuesMatrix[index][p];
      valuesMatrix[index][q] = sine * aip + cosine * aiq;
      valuesMatrix[q][index] = valuesMatrix[index][q];
    }
    valuesMatrix[p][p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    valuesMatrix[q][q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    valuesMatrix[p][q] = 0;
    valuesMatrix[q][p] = 0;

    for (let row = 0; row < size; row++) {
      const vip = vectors[row][p];
      const viq = vectors[row][q];
      vectors[row][p] = cosine * vip - sine * viq;
      vectors[row][q] = sine * vip + cosine * viq;
    }
  }

  return {
    values: valuesMatrix.map((row, index) => row[index]),
    vectors,
  };
}

function dltMatrix(board: PointLike[], photo: PointLike[]): { matrix: number[] | null; rankRatio: number } {
  const ata = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));

  for (let index = 0; index < board.length; index++) {
    const { x, y } = board[index];
    const { x: u, y: v } = photo[index];
    const rows = [
      [-x, -y, -1, 0, 0, 0, u * x, u * y, u],
      [0, 0, 0, -x, -y, -1, v * x, v * y, v],
    ];
    for (const row of rows) {
      for (let r = 0; r < 9; r++) {
        for (let column = r; column < 9; column++) {
          ata[r][column] += row[r] * row[column];
        }
      }
    }
  }
  for (let row = 0; row < 9; row++) {
    for (let column = 0; column < row; column++) ata[row][column] = ata[column][row];
  }

  const eigen = symmetricEigen(ata);
  const order = eigen.values
    .map((value, index) => ({ value: Math.abs(value), index }))
    .sort((a, b) => a.value - b.value);
  const largest = order.at(-1)?.value ?? 0;
  const rankRatio = largest === 0 ? 0 : order[1].value / largest;
  if (rankRatio < RANK_ERROR_RATIO) return { matrix: null, rankRatio };

  const smallestIndex = order[0].index;
  return {
    matrix: eigen.vectors.map((row) => row[smallestIndex]),
    rankRatio,
  };
}

function project(matrix: number[], point: PointLike): PointLike | null {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= MATRIX_EPSILON) return null;
  const result = {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
  return Number.isFinite(result.x) && Number.isFinite(result.y) ? result : null;
}

function isValidBoardDimensions(value: BoardDimensions): boolean {
  return Number.isFinite(value.width) && value.width > 0
    && Number.isFinite(value.height) && value.height > 0;
}

function reprojectionError(
  dx: number,
  dy: number,
  dimensions: BoardDimensions | number,
): number {
  if (typeof dimensions === 'number') return Math.hypot(dx, dy) / dimensions;
  return Math.hypot(dx * dimensions.width, dy * dimensions.height)
    / Math.hypot(dimensions.width, dimensions.height);
}

/** Löst die Homografie von normalisierten Board- zu Foto-Koordinaten mittels
 *  normalisierter DLT und Least Squares für 4 bis 12 Punktpaare.
 *
 * Ein Objekt mit positiven physischen Boardabmessungen gewichtet die
 * Reprojektionsfehler achsenweise in realen Boardeinheiten. Die numerische
 * Form bleibt vorübergehend für bestehende Aufrufer erhalten; sie bedeutet
 * ausschließlich den bisherigen Legacy-Normraumteiler und keine physische
 * Boarddiagonale.
 */
export function solveHomography(
  pairs: CalibrationPointPair[],
  boardDimensions: BoardDimensions | number,
): HomographyResult {
  if (pairs.length < MIN_PAIRS || pairs.length > MAX_PAIRS) {
    return errorResult('Es werden 4 bis 12 Kalibrierpunkt-Paare benötigt.');
  }
  if (typeof boardDimensions === 'number') {
    if (!Number.isFinite(boardDimensions) || boardDimensions <= 0) {
      return errorResult('Der Legacy-Normraumteiler muss positiv und endlich sein.');
    }
  } else if (!boardDimensions || !isValidBoardDimensions(boardDimensions)) {
    return errorResult('Breite und Höhe des Boards müssen positiv und endlich sein.');
  }

  const board = pairs.map((pair) => pair.board);
  const photo = pairs.map((pair) => pair.photo);
  if ([...board, ...photo].some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return errorResult('Alle Koordinaten müssen endliche Zahlen sein.');
  }

  for (const points of [board, photo]) {
    for (let first = 0; first < points.length; first++) {
      for (let second = first + 1; second < points.length; second++) {
        if (distanceSquared(points[first], points[second]) < MIN_SEPARATION ** 2) {
          return errorResult('Doppelte oder zu nahe Kalibrierpunkte.');
        }
      }
    }
  }

  const normalizedBoard = normalizePoints(board);
  const normalizedPhoto = normalizePoints(photo);
  if (!normalizedBoard || !normalizedPhoto) {
    return errorResult('Die Punktverteilung kann nicht normalisiert werden.');
  }

  const warnings: string[] = [];
  const boardSpread = spreadRatio(normalizedBoard.points);
  const photoSpread = spreadRatio(normalizedPhoto.points);
  if (boardSpread < COLLINEAR_ERROR_RATIO || photoSpread < COLLINEAR_ERROR_RATIO) {
    return errorResult('Die Kalibrierpunkte sind kollinear oder nahezu kollinear.');
  }
  if (boardSpread < COLLINEAR_WARNING_RATIO || photoSpread < COLLINEAR_WARNING_RATIO) {
    warnings.push('Die Kalibrierpunkte liegen ungünstig nahe an einer Geraden.');
  }

  const solved = dltMatrix(normalizedBoard.points, normalizedPhoto.points);
  if (!solved.matrix) {
    return errorResult('Die Kalibrierkonfiguration ist singulär.', warnings);
  }
  if (solved.rankRatio < RANK_WARNING_RATIO) {
    warnings.push('Die Kalibrierkonfiguration ist numerisch instabil.');
  }

  const denormalized = multiply3(
    multiply3(invertSimilarity(normalizedPhoto.transform), solved.matrix),
    normalizedBoard.transform,
  );
  const matrix = normalizeMatrixScale(denormalized);
  if (!matrix || Math.abs(determinant3(matrix)) <= MATRIX_EPSILON) {
    return errorResult('Die Homografiematrix ist singulär.', warnings);
  }
  if (pairs.some((pair) => project(matrix, pair.board) === null)) {
    return errorResult('Mindestens ein Kalibrierpunkt liegt auf der Projektionssingularität.', warnings);
  }

  let rmsError: number | null = null;
  let maxError: number | null = null;
  if (pairs.length >= 5) {
    const inverse = invertHomography(matrix);
    if (!inverse) return errorResult('Die Homografiematrix ist nicht invertierbar.', warnings);

    const scaledErrors: number[] = [];
    for (const pair of pairs) {
      const reprojected = project(inverse, pair.photo);
      if (!reprojected) {
        return errorResult('Ein Fotopunkt kann nicht zurückprojiziert werden.', warnings);
      }
      scaledErrors.push(reprojectionError(
        reprojected.x - pair.board.x,
        reprojected.y - pair.board.y,
        boardDimensions,
      ));
    }
    rmsError = Math.sqrt(scaledErrors.reduce((sum, error) => sum + error * error, 0) / scaledErrors.length);
    maxError = Math.max(...scaledErrors);
    if (rmsError > WARNING_THRESHOLD || maxError > WARNING_THRESHOLD) {
      warnings.push('Der Reprojektionsfehler liegt über der Warnschwelle von 0,75 %.');
    }
  }

  return {
    matrix,
    status: warnings.length === 0 ? 'ok' : 'degraded',
    rmsError,
    maxError,
    warnings,
    error: null,
  };
}

/** Wendet eine row-major 3×3-Homografie auf einen Punkt an. */
export function applyHomography(matrix: number[], point: PointLike): PointLike {
  if (matrix.length !== 9 || matrix.some((value) => !Number.isFinite(value))) {
    throw new TypeError('Eine Homografiematrix muss aus 9 endlichen Zahlen bestehen.');
  }
  const result = project(matrix, point);
  if (!result) throw new RangeError('Der Punkt liegt auf der Projektionssingularität.');
  return result;
}

/** Invertiert eine row-major 3×3-Homografie oder liefert null bei Singularität. */
export function invertHomography(matrix: number[]): number[] | null {
  if (matrix.length !== 9 || matrix.some((value) => !Number.isFinite(value))) return null;
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = determinant3(matrix);
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= MATRIX_EPSILON) return null;
  const inverseDeterminant = 1 / determinant;
  return [
    (e * i - f * h) * inverseDeterminant,
    (c * h - b * i) * inverseDeterminant,
    (b * f - c * e) * inverseDeterminant,
    (f * g - d * i) * inverseDeterminant,
    (a * i - c * g) * inverseDeterminant,
    (c * d - a * f) * inverseDeterminant,
    (d * h - e * g) * inverseDeterminant,
    (b * g - a * h) * inverseDeterminant,
    (a * e - b * d) * inverseDeterminant,
  ];
}
