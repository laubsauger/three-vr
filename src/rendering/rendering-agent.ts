import type { Scene } from "three";

import type { IntegrationContext, RenderingAgent } from "../contracts/integration";
import { selectRenderGraphView } from "../topology";
import { InfraSceneRenderer } from "./scene-renderer";

export interface RenderingAgentOptions {
  scene: Scene;
}

export function createRenderingAgent(options: RenderingAgentOptions): RenderingAgent {
  const renderer = new InfraSceneRenderer(options.scene);
  let unsubscribeTopology: (() => void) | null = null;
  let unsubscribeMarkers: (() => void) | null = null;
  let animationHandle = 0;

  const animate = (timeMs: number): void => {
    renderer.tick(timeMs);
    animationHandle = window.requestAnimationFrame(animate);
  };

  return {
    async init(context: IntegrationContext): Promise<void> {
      try {
        unsubscribeTopology = context.events.on("topology/snapshot", (payload) => {
          const graph = selectRenderGraphView(payload.snapshot);
          renderer.updateGraph(graph);
        });

        unsubscribeMarkers = context.events.on("tracking/markers", (payload) => {
          renderer.updateTrackedMarkers(payload.markers);
        });

        animationHandle = window.requestAnimationFrame(animate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.events.emit("app/error", {
          code: "RENDER_INIT_FAILED",
          source: "rendering",
          message: `Failed to initialize rendering agent: ${message}`,
          recoverable: true,
          timestampMs: performance.now()
        });
      }
    },

    async dispose(): Promise<void> {
      if (unsubscribeTopology) {
        unsubscribeTopology();
        unsubscribeTopology = null;
      }
      if (unsubscribeMarkers) {
        unsubscribeMarkers();
        unsubscribeMarkers = null;
      }
      if (animationHandle) {
        window.cancelAnimationFrame(animationHandle);
        animationHandle = 0;
      }
      renderer.dispose();
    }
  };
}
