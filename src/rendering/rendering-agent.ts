import { Quaternion, Scene, Vector3 } from "three";

import type { IntegrationContext, RenderingAgent } from "../contracts/integration";
import { selectRenderGraphView } from "../topology";
import { InfraSceneRenderer } from "./scene-renderer";
import { KmlMapRenderer, parseKml } from "../kml";

export interface RenderingAgentOptions {
  scene: Scene;
  /** Raw KML text to load as a map overlay. */
  kmlText?: string;
}

export function createRenderingAgent(options: RenderingAgentOptions): RenderingAgent {
  const renderer = new InfraSceneRenderer(options.scene);
  const kmlMap = new KmlMapRenderer();
  options.scene.add(kmlMap.getRoot());

  let unsubscribeTopology: (() => void) | null = null;
  let unsubscribeMarkers: (() => void) | null = null;
  let unsubscribeXrState: (() => void) | null = null;
  let animationHandle = 0;

  // Load KML if provided
  if (options.kmlText) {
    const network = parseKml(options.kmlText);
    kmlMap.loadNetwork(network);
  }

  const markerPos = new Vector3();
  const markerQuat = new Quaternion();

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

          // Anchor KML map to the first detected marker
          if (kmlMap.isLoaded() && payload.markers.length > 0) {
            const first = payload.markers[0];
            markerPos.set(
              first.pose.position.x,
              first.pose.position.y,
              first.pose.position.z
            );
            markerQuat.set(
              first.pose.rotation.x,
              first.pose.rotation.y,
              first.pose.rotation.z,
              first.pose.rotation.w
            );
            kmlMap.anchorToMarker(markerPos, markerQuat);
          } else {
            kmlMap.hide();
          }
        });

        unsubscribeXrState = context.events.on("xr/state", (payload) => {
          if (payload.state === "running") {
            renderer.setBoundaryPolygon(context.xrRuntime.getBoundaryPolygon());
          } else {
            renderer.setBoundaryPolygon(null);
          }
        });

        if (context.xrRuntime.getState() === "running") {
          renderer.setBoundaryPolygon(context.xrRuntime.getBoundaryPolygon());
        }

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
      if (unsubscribeXrState) {
        unsubscribeXrState();
        unsubscribeXrState = null;
      }
      if (animationHandle) {
        window.cancelAnimationFrame(animationHandle);
        animationHandle = 0;
      }
      kmlMap.dispose();
      renderer.dispose();
    }
  };
}
