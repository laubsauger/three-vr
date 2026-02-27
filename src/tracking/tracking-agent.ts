import type { IntegrationContext, TrackingAgent } from "../contracts/integration";
import type { XrFrameTick } from "../contracts/xr";
import type { MarkerDetector, SmootherConfig } from "./types";
import { PoseSmoother } from "./pose-smoother";
import { MockMarkerDetector } from "./detector";

export interface TrackingAgentOptions {
  /** Pluggable detector. Defaults to MockMarkerDetector. */
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
  const detector = options.detector ?? new MockMarkerDetector();
  const smoother = new PoseSmoother(options.smoother);
  const detectionIntervalMs = options.detectionIntervalMs ?? 50;

  let unsubscribeFrame: (() => void) | null = null;
  let lastDetectionMs = 0;

  function onFrame(context: IntegrationContext, tick: XrFrameTick): void {
    const now = tick.time;

    // Throttle detection to save CPU budget
    if (now - lastDetectionMs < detectionIntervalMs) {
      return;
    }
    lastDetectionMs = now;

    const rawDetections = detector.detect(tick.frame, tick.referenceSpace);
    const smoothedMarkers = smoother.update(rawDetections, now);

    if (smoothedMarkers.length > 0) {
      context.events.emit("tracking/markers", {
        markers: smoothedMarkers,
        timestampMs: now,
      });
    }
  }

  return {
    async init(context: IntegrationContext): Promise<void> {
      smoother.reset();
      lastDetectionMs = 0;

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
