import type { IntegrationContext, TelemetryAgent } from "../contracts/integration";
import { MockTelemetryStream } from "./mock-stream";

export interface TelemetryAgentOptions {
  tickIntervalMs?: number;
  stream?: MockTelemetryStream;
}

export function createTelemetryAgent(options: TelemetryAgentOptions = {}): TelemetryAgent {
  const tickIntervalMs = options.tickIntervalMs ?? 1000;
  const stream = options.stream ?? new MockTelemetryStream();

  let timerId: number | null = null;
  let unsubscribeTopology: (() => void) | null = null;
  let ready = false;

  function stopTimer(): void {
    if (timerId === null) {
      return;
    }
    window.clearInterval(timerId);
    timerId = null;
  }

  return {
    async init(context: IntegrationContext): Promise<void> {
      unsubscribeTopology = context.events.on("topology/snapshot", (payload) => {
        stream.setSnapshot(payload.snapshot);
        ready = true;
      });

      timerId = window.setInterval(() => {
        try {
          if (!ready) {
            return;
          }

          const timestampMs = performance.now();
          const batch = stream.generateBatch(timestampMs);
          const changedNodeIds = batch.nodeMetrics.map((metric) => metric.nodeId);
          const changedLinkIds = batch.linkMetrics.map((metric) => metric.linkId);

          if (changedNodeIds.length === 0 && changedLinkIds.length === 0) {
            return;
          }

          context.events.emit("telemetry/update", {
            source: "mock",
            changedNodeIds,
            changedLinkIds,
            nodeMetrics: batch.nodeMetrics,
            linkMetrics: batch.linkMetrics,
            timestampMs
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          context.events.emit("app/error", {
            code: "TELEMETRY_STREAM_FAILED",
            source: "telemetry",
            message: `Telemetry stream tick failed: ${message}`,
            recoverable: true,
            timestampMs: performance.now()
          });
        }
      }, tickIntervalMs);
    },

    async dispose(): Promise<void> {
      stopTimer();
      if (unsubscribeTopology) {
        unsubscribeTopology();
        unsubscribeTopology = null;
      }
      ready = false;
    }
  };
}
