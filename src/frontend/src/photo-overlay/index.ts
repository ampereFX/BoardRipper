export type {
  CalibrationPointPair,
  HomographyResult,
  HomographyStatus,
  ManualBoardMask,
  NormalizedPoint,
  OverlayAssetMetadata,
  OverlayDisplayPreferences,
  OverlayMetadata,
  OverlaySide,
  PhotoCalibration,
} from './types';
export type {
  BoardPhotoAssetState,
  OverlayVariant,
  StoredOverlay,
} from './api-client';
export {
  buildOverlayUrl,
  deleteBoardPhotoOverlay,
  getBoardPhotoAsset,
  PhotoOverlayApiError,
  putBoardPhotoCalibration,
  putBoardPhotoMask,
  putBoardPhotoOverlay,
} from './api-client';
export { solveHomography, applyHomography, invertHomography } from './homography';
export {
  CalibrationSession,
  CalibrationSessionError,
  snapToOutline,
  MAX_CALIBRATION_PAIRS,
  MIN_CALIBRATION_PAIRS,
  RECOMMENDED_CALIBRATION_PAIRS,
  REPROJECTION_WARNING_THRESHOLD,
} from './calibration-session';
export type {
  CalibrationPreviewMode,
  CalibrationSessionOptions,
  CalibrationSessionState,
  CalibrationSessionStatistics,
  CalibrationSessionValidation,
  CalibrationViewport,
  CalibrationViewportName,
  NumberedCalibrationPair,
} from './calibration-session';
export { computeSubboardKey, computeSubboardKeys } from './subboard-key';
export { validateManualBoardMask } from './mask-validation';
export type { MaskValidationResult } from './mask-validation';
export {
  clearOverlayDisplayPreferences,
  loadOverlayDisplayPreferences,
  setOverlayDisplayPreferences,
} from './view-preferences';
export { PhotoOverlayStore, photoOverlayStore } from './overlay-store';
export type { OverlayBoardState, OverlaySideState, OverlayStatus } from './overlay-store';
export { BoardLifecycleController, boardLifecycleController } from './board-lifecycle-controller';
export type {
  OverlaySideLifecycle,
  OverlaySubboardLifecycle,
  OverlayTabLifecycle,
} from './board-lifecycle-controller';
