import type { IntegrationContext, TrackingAgent } from "../contracts/integration";
import type { XrFrameTick } from "../contracts/xr";
import type { MarkerDetector, SmootherConfig } from "./types";
import { PoseSmoother } from "./pose-smoother";
import { CameraWorkerMarkerDetector, MockMarkerDetector } from "./detector";

export type TrackingMode = "camera-worker" | "mock";

export interface TrackingAgentOptions {
  /** Detection backend mode. Defaults to camera-worker. */
  mode?: TrackingMode;
  /** Pluggable detector. Overrides mode selection when provided. */
  detector?: MarkerDetector;
  /** Smoother configuration overrides. */
  smoother?: Partial<SmootherConfig>;
  /**
   * Minimum interval between detection runs in ms.
   * Skipping frames keeps CPU budget low on Quest. Default 50 (≈20 Hz).
   */
  detectionIntervalMs?: number;
}

export function createTrackingAgent(options: TrackingAgentOptions = {}): TrackingAgent {
  const detector =
    options.detector ??
    (options.mode === "mock" ? new MockMarkerDetector() : new CameraWorkerMarkerDetector());
  const smoother = new PoseSmoother(options.smoother);
  const detectionIntervalMs = options.detectionIntervalMs ?? 50;

  let unsubscribeFrame: (() => void) | null = null;
  let lastDetectionMs = 0;
  let emittedDetectorFailure = false;
  let lastStatusEmitMs = 0;

  const backend = resolveBackend(detector);

  function emitStatus(context: IntegrationContext, timestampMs: number): void {
    if (timestampMs - lastStatusEmitMs < 450) {
      return;
    }
    lastStatusEmitMs = timestampMs;

    context.events.emit("tracking/status", {
      backend,
      detectorStatus: resolveDetectorStatus(detector),
      timestampMs
    });
  }

  function onFrame(context: IntegrationContext, tick: XrFrameTick): void {
    const now = tick.time;
    emitStatus(context, now);

    // Throttle detection to save CPU budget
    if (now - lastDetectionMs < detectionIntervalMs) {
      return;
    }
    lastDetectionMs = now;

    const rawDetections = detector.detect(tick.frame, tick.referenceSpace);
    if (detector instanceof CameraWorkerMarkerDetector && detector.getStatus() === "failed") {
      if (!emittedDetectorFailure) {
        context.events.emit("app/error", {
          code: "TRACKING_INIT_FAILED",
          source: "tracking",
          message: "Camera worker detector failed to initialize. Check camera permissions.",
          recoverable: true,
          timestampMs: now
        });
        emittedDetectorFailure = true;
      }
    }
    const smoothedMarkers = smoother.update(rawDetections, now);

    context.events.emit("tracking/markers", {
      markers: smoothedMarkers,
      timestampMs: now,
    });
  }

  return {
    async init(context: IntegrationContext): Promise<void> {
      smoother.reset();
      lastDetectionMs = 0;
      emittedDetectorFailure = false;
      lastStatusEmitMs = 0;

      emitStatus(context, performance.now());

      unsubscribeFrame = context.events.on("xr/frame", (tick) => {
        onFrame(context, tick);
      });
    },

    async dispose(): Promise<void> {
      if (unsubscribeFrame) {
        unsubscribeFrame();
        unsubscribeFrame = null;
      }
      smoother.reset();
      detector.dispose();
    },
  };
}

function resolveBackend(detector: MarkerDetector): "camera-worker" | "mock" | "custom" {
  if (detector instanceof CameraWorkerMarkerDetector) {
    return "camera-worker";
  }
  if (detector instanceof MockMarkerDetector) {
    return "mock";
  }
  return "custom";
}

function resolveDetectorStatus(detector: MarkerDetector): "idle" | "starting" | "ready" | "failed" {
  if (detector instanceof CameraWorkerMarkerDetector) {
    return detector.getStatus();
  }
  return "ready";
}
