import type {
  HandData,
  Handedness,
  LinkMetricUpdate,
  NodeMetricUpdate,
  QuaternionLike,
  TopologySnapshot,
  TrackedMarker,
  Vector3Like
} from "./domain";
import type { XrCapabilities, XrFrameTick, XrRuntimeState } from "./xr";

export type AppDomain =
  | "xr-core"
  | "tracking"
  | "topology"
  | "telemetry"
  | "rendering"
  | "interaction"
  | "app";

export type AppErrorCode =
  | "XR_UNAVAILABLE"
  | "XR_SESSION_START_FAILED"
  | "XR_SESSION_STOP_FAILED"
  | "CAMERA_PERMISSION_FAILED"
  | "TRACKING_INIT_FAILED"
  | "TOPOLOGY_LOAD_FAILED"
  | "TELEMETRY_STREAM_FAILED"
  | "RENDER_INIT_FAILED"
  | "INTEGRATION_CONFLICT"
  | "UNKNOWN";

export interface AppErrorEnvelope {
  code: AppErrorCode;
  source: AppDomain;
  message: string;
  recoverable: boolean;
  timestampMs: number;
  details?: Record<string, unknown>;
}

export interface TopologyDeltaEvent {
  changedNodeIds: string[];
  changedLinkIds: string[];
  timestampMs: number;
}

export interface SelectionChangeEvent {
  selectedNodeId: string | null;
  selectedLinkId: string | null;
  timestampMs: number;
}

export interface PerformanceSampleEvent {
  mode: "xr" | "desktop";
  fps: number;
  avgFrameTimeMs: number;
  p95FrameTimeMs: number;
  sampleSize: number;
  timestampMs: number;
}

export interface TrackingStatusEvent {
  backend: "camera-worker" | "mock" | "custom";
  detectorStatus: "idle" | "starting" | "ready" | "failed";
  timestampMs: number;
}

export interface SpawnAnchorEvent {
  markerId: number | null;
  position: Vector3Like | null;
  rotation: QuaternionLike | null;
  source: "desktop-prelock" | "xr-resolved" | "viewer-fallback" | "cleared";
  timestampMs: number;
}

export interface AppEventMap {
  "xr/state": {
    state: XrRuntimeState;
    timestampMs: number;
  };
  "xr/capabilities": {
    capabilities: XrCapabilities;
    timestampMs: number;
  };
  "xr/frame": XrFrameTick;
  "tracking/markers": {
    markers: TrackedMarker[];
    timestampMs: number;
  };
  "tracking/status": TrackingStatusEvent;
  "tracking/spawn-anchor": SpawnAnchorEvent;
  "topology/snapshot": {
    snapshot: TopologySnapshot;
    timestampMs: number;
  };
  "topology/delta": TopologyDeltaEvent;
  "telemetry/update": {
    source: "ws" | "rest" | "mock";
    changedNodeIds: string[];
    changedLinkIds: string[];
    nodeMetrics: NodeMetricUpdate[];
    linkMetrics: LinkMetricUpdate[];
    timestampMs: number;
  };
  "interaction/selection-change": SelectionChangeEvent;
  "interaction/hands": {
    hands: HandData[];
    timestampMs: number;
  };
  "interaction/pinch": {
    hand: Handedness;
    state: "start" | "end";
    position: Vector3Like;
    timestampMs: number;
  };
  "interaction/point": {
    hand: Handedness;
    state: "start" | "end";
    position: Vector3Like;
    direction: Vector3Like;
    timestampMs: number;
  };
  "interaction/hover": {
    kind: "node" | "link" | null;
    id: string | null;
    timestampMs: number;
  };
  "app/performance": PerformanceSampleEvent;
  "app/error": AppErrorEnvelope;
}

export type AppEventName = keyof AppEventMap;
