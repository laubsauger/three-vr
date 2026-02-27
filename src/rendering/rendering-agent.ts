import { Quaternion, Scene, Vector3 } from "three";

import type { IntegrationContext, RenderingAgent } from "../contracts/integration";
import { selectRenderGraphView } from "../topology";
import { InfraSceneRenderer } from "./scene-renderer";
import { KmlMapRenderer, parseKml } from "../kml";
import { MarkerIndicatorManager } from "./marker-indicator";
import { DebugHud } from "./debug-hud";
import type { DebugHudData } from "./debug-hud";

export interface RenderingAgentOptions {
  scene: Scene;
  /** Raw KML text to load as a map overlay. */
  kmlText?: string;
}

export function createRenderingAgent(options: RenderingAgentOptions): RenderingAgent {
  const renderer = new InfraSceneRenderer(options.scene);
  const kmlMap = new KmlMapRenderer();
  const markerIndicators = new MarkerIndicatorManager();
  const debugHud = new DebugHud();

  options.scene.add(kmlMap.getRoot());
  options.scene.add(markerIndicators.getRoot());
  options.scene.add(debugHud.sprite);

  // Position debug HUD in a default spot (updated per-frame in XR via camera)
  debugHud.sprite.position.set(-0.3, 1.6, -0.8);

  let unsubscribeTopology: (() => void) | null = null;
  let unsubscribeMarkers: (() => void) | null = null;
  let unsubscribeXrState: (() => void) | null = null;
  let unsubscribeXrFrame: (() => void) | null = null;
  let unsubscribePerformance: (() => void) | null = null;
  let unsubscribeTrackingStatus: (() => void) | null = null;
  let animationHandle = 0;
  let xrRunning = false;

  // Load KML if provided
  if (options.kmlText) {
    const network = parseKml(options.kmlText);
    kmlMap.loadNetwork(network);
  }

  const markerPos = new Vector3();
  const markerQuat = new Quaternion();

  // Debug HUD state
  const hudData: DebugHudData = {
    fps: 0,
    avgFrameTimeMs: 0,
    mode: "desktop",
    markerCount: 0,
    bestMarkerId: null,
    bestConfidence: 0,
    trackingBackend: "unknown",
    detectorStatus: "idle",
    xrState: "idle",
  };

  const animate = (timeMs: number): void => {
    if (!xrRunning) {
      renderer.tick(timeMs);
    }
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
          markerIndicators.update(payload.markers, payload.timestampMs);

          // Update HUD marker data
          hudData.markerCount = payload.markers.length;
          if (payload.markers.length > 0) {
            // Pick highest confidence as best
            let best = payload.markers[0];
            for (const m of payload.markers) {
              if (m.pose.confidence > best.pose.confidence) best = m;
            }
            hudData.bestMarkerId = best.markerId;
            hudData.bestConfidence = best.pose.confidence;
          } else {
            hudData.bestMarkerId = null;
            hudData.bestConfidence = 0;
          }

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
          xrRunning = payload.state === "running";
          hudData.xrState = payload.state;
          if (payload.state === "running") {
            renderer.setBoundaryPolygon(context.xrRuntime.getBoundaryPolygon());
          } else {
            renderer.setBoundaryPolygon(null);
          }
        });

        unsubscribeXrFrame = context.events.on("xr/frame", (payload) => {
          if (xrRunning) {
            renderer.tick(payload.time);
          }
          debugHud.update(hudData, payload.time);
        });

        unsubscribePerformance = context.events.on("app/performance", (payload) => {
          hudData.fps = payload.fps;
          hudData.avgFrameTimeMs = payload.avgFrameTimeMs;
          hudData.mode = payload.mode;
        });

        unsubscribeTrackingStatus = context.events.on("tracking/status", (payload) => {
          hudData.trackingBackend = payload.backend;
          hudData.detectorStatus = payload.detectorStatus;
        });

        if (context.xrRuntime.getState() === "running") {
          xrRunning = true;
          hudData.xrState = "running";
          renderer.setBoundaryPolygon(context.xrRuntime.getBoundaryPolygon());
        } else {
          xrRunning = false;
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
      if (unsubscribeXrFrame) {
        unsubscribeXrFrame();
        unsubscribeXrFrame = null;
      }
      if (unsubscribePerformance) {
        unsubscribePerformance();
        unsubscribePerformance = null;
      }
      if (unsubscribeTrackingStatus) {
        unsubscribeTrackingStatus();
        unsubscribeTrackingStatus = null;
      }
      if (animationHandle) {
        window.cancelAnimationFrame(animationHandle);
        animationHandle = 0;
      }
      kmlMap.dispose();
      markerIndicators.dispose();
      debugHud.dispose();
      renderer.dispose();
    }
  };
}
