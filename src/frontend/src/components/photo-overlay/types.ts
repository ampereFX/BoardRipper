import type { OverlayAssetMetadata, OverlaySide } from '../../photo-overlay/types';

export type PhotoOverlayCardStatus = 'empty' | 'loading' | 'ready' | 'error';

export type PhotoOverlayBuildMode = 'online' | 'lite' | 'offline';

/** A physical board that can receive an overlay on either side. */
export interface PhotoOverlaySubboardOption {
  key: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** Controlled display state for one physical board side. */
export interface PhotoOverlayCardProps {
  side: OverlaySide;
  status: PhotoOverlayCardStatus;
  metadata: OverlayAssetMetadata | null;
  previewUrl: string | null;
  error: string | null;
  visible: boolean;
  opacity: number;
  disabled?: boolean;
  onImport: (file: File, side: OverlaySide) => void;
  onVisibilityChange: (visible: boolean, side: OverlaySide) => void;
  onOpacityChange: (opacity: number, side: OverlaySide) => void;
  onRecalibrate: (side: OverlaySide) => void;
  onRemove: (side: OverlaySide) => void;
}

export interface PhotoOverlayPanelProps {
  subboards: readonly PhotoOverlaySubboardOption[];
  selectedSubboardKey: string | null;
  onSubboardChange: (subboardKey: string) => void;
  cards: Readonly<Record<OverlaySide, PhotoOverlayCardProps>>;
  mode?: PhotoOverlayBuildMode;
  disabled?: boolean;
  className?: string;
}
