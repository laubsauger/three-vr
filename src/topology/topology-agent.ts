import type { IntegrationContext, TopologyAgent } from "../contracts/integration";
import { loadMockTopologySnapshot } from "./mock-topology";
import { TopologyStore } from "./store";

export interface TopologyAgentOptions {
  store?: TopologyStore;
}

export function createTopologyAgent(options: TopologyAgentOptions = {}): TopologyAgent {
  const store = options.store ?? new TopologyStore();
  let unsubscribeTelemetry: (() => void) | null = null;

  return {
    async init(context: IntegrationContext): Promise<void> {
      try {
        const snapshot = await loadMockTopologySnapshot();
        const loaded = store.loadSnapshot(snapshot);

        context.events.emit("topology/snapshot", {
          snapshot: loaded,
          timestampMs: loaded.generatedAtMs
        });

        unsubscribeTelemetry = context.events.on("telemetry/update", (update) => {
          const result = store.applyMetricUpdates(
            update.nodeMetrics,
            update.linkMetrics,
            update.timestampMs
          );

          if (result.changedNodeIds.length === 0 && result.changedLinkIds.length === 0) {
            return;
          }

          context.events.emit("topology/delta", {
            changedNodeIds: result.changedNodeIds,
            changedLinkIds: result.changedLinkIds,
            timestampMs: update.timestampMs
          });

          context.events.emit("topology/snapshot", {
            snapshot: result.snapshot,
            timestampMs: update.timestampMs
          });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.events.emit("app/error", {
          code: "TOPOLOGY_LOAD_FAILED",
          source: "topology",
          message: `Failed to load topology snapshot: ${message}`,
          recoverable: true,
          timestampMs: performance.now()
        });
      }
    },

    async dispose(): Promise<void> {
      if (unsubscribeTelemetry) {
        unsubscribeTelemetry();
        unsubscribeTelemetry = null;
      }
    }
  };
}
