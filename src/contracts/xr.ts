export type XrRuntimeState = "idle" | "requesting" | "running" | "ending" | "failed";

export type CapabilityState = "supported" | "unsupported" | "unknown";

export type XrSessionMode = "immersive-ar" | "immersive-vr";

export type XrReferenceSpaceType =
  | "viewer"
  | "local"
  | "local-floor"
  | "bounded-floor"
  | "unbounded";

export interface XrCapabilities {
  webxr: boolean;
  immersiveAr: CapabilityState;
  immersiveVr: CapabilityState;
  anchors: CapabilityState;
  hitTest: CapabilityState;
  domOverlay: CapabilityState;
  handTracking: CapabilityState;
}

export interface XrFrameTick {
  time: number;
  deltaMs: number;
  frame: unknown;
  referenceSpace: unknown;
}

export interface XrBoundaryPoint {
  x: number;
  z: number;
}

export interface XrSessionStartOptions {
  mode?: XrSessionMode;
  referenceSpaceOrder?: XrReferenceSpaceType[];
  requiredFeatures?: string[];
  optionalFeatures?: string[];
  domOverlayRoot?: HTMLElement;
}
