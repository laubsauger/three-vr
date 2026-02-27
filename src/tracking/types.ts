import type { AnchorPose, TrackedMarker, Vector3Like, QuaternionLike } from "../contracts";

/** Raw detection output from a single frame before smoothing. */
export interface RawMarkerDetection {
  markerId: number;
  /** Estimated pose from the detector (noisy, unsmoothed). */
  pose: AnchorPose;
  /** Physical marker size in meters, if known. */
  sizeMeters?: number;
}

/** Interface for pluggable marker detection backends. */
export interface MarkerDetector {
  /** Process one XR frame and return detected markers. */
  detect(frame: unknown, referenceSpace: unknown): RawMarkerDetection[];
  /** Release resources held by the detector. */
  dispose(): void;
}

/** Configuration for the pose smoothing filter. */
export interface SmootherConfig {
  /** Lerp factor for position (0 = no smoothing, 1 = no filtering). Default 0.3. */
  positionAlpha: number;
  /** Slerp factor for rotation (0 = no smoothing, 1 = no filtering). Default 0.25. */
  rotationAlpha: number;
  /** Time in ms after which a marker is considered lost. Default 2000. */
  staleThresholdMs: number;
}

export const DEFAULT_SMOOTHER_CONFIG: SmootherConfig = {
  positionAlpha: 0.3,
  rotationAlpha: 0.25,
  staleThresholdMs: 2000,
};

/** Per-marker smoothing state. */
export interface MarkerSmoothState {
  markerId: number;
  position: Vector3Like;
  rotation: QuaternionLike;
  confidence: number;
  lastSeenAtMs: number;
  detectionCount: number;
  sizeMeters?: number;
}

export type { TrackedMarker, AnchorPose, Vector3Like, QuaternionLike };
