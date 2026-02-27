import { Camera, Quaternion, Scene, Vector3 } from "three";

import type { IntegrationContext, RenderingAgent } from "../contracts/integration";
import { selectRenderGraphView } from "../topology";
import { InfraSceneRenderer } from "./scene-renderer";
import { KmlMapRenderer, parseKml } from "../kml";
import { MarkerIndicatorManager } from "./marker-indicator";
import { HandVisualizer } from "./hand-visualizer";
import { InfraLabelManager } from "./infra-labels";
import { DebugHud } from "./debug-hud";
import type { DebugHudData } from "./debug-hud";

export interface RenderingAgentOptions {
  scene: Scene;
  camera: Camera;
  /** Raw KML text to load as a map overlay. */
  kmlText?: string;
}

export function createRenderingAgent(options: RenderingAgentOptions): RenderingAgent {
  const renderer = new InfraSceneRenderer(options.scene);
  const kmlMap = new KmlMapRenderer();
  const markerIndicators = new MarkerIndicatorManager();
  const handVisualizer = new HandVisualizer();
  const labelManager = new InfraLabelManager();
  const debugHud = new DebugHud();

  options.scene.add(kmlMap.getRoot());
  options.scene.add(markerIndicators.getRoot());
  options.scene.add(handVisualizer.getRoot());
  options.scene.add(labelManager.getRoot());
  options.scene.add(debugHud.sprite);

  // Position debug HUD in bottom-left (updated per-frame via camera follow)
  debugHud.sprite.position.set(-0.35, 1.15, -0.8);

  let unsubscribeTopology: (() => void) | null = null;
  let unsubscribeMarkers: (() => void) | null = null;
  let unsubscribeXrState: (() => void) | null = null;
  let unsubscribeXrFrame: (() => void) | null = null;
  let unsubscribePerformance: (() => void) | null = null;
  let unsubscribeTrackingStatus: (() => void) | null = null;
  let unsubscribeHands: (() => void) | null = null;
  let unsubscribePinch: (() => void) | null = null;
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
    handsDetected: 0,
    leftPinch: false,
    rightPinch: false,
    leftPinchStrength: 0,
    rightPinchStrength: 0,
    hudMode: "follow",
    leftPoint: false,
    rightPoint: false,
    leftPointStrength: 0,
    rightPointStrength: 0,
    cameraWarning: null,
  };

  const animate = (timeMs: number): void => {
    if (!xrRunning) {
      renderer.tick(timeMs);
    }
    labelManager.updateVisibility(options.camera);
    // Keep HUD position locked to camera every frame (including desktop)
    debugHud.update(hudData, timeMs, options.camera);
    animationHandle = window.requestAnimationFrame(animate);
  };

  return {
    async init(context: IntegrationContext): Promise<void> {
      try {
        unsubscribeTopology = context.events.on("topology/snapshot", (payload) => {
          const graph = selectRenderGraphView(payload.snapshot);
          renderer.updateGraph(graph);

          // Update labels with resolved positions
          const nodePositions = renderer.getNodePositions();
          const linkMidpoints = renderer.getLinkMidpoints();
          labelManager.updateGraph(graph, nodePositions, linkMidpoints);
          labelManager.updateVisibility(options.camera);
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
            // Set camera warning if detector is not ready when entering XR
            if (hudData.trackingBackend === "camera-worker" && hudData.detectorStatus !== "ready") {
              hudData.cameraWarning = hudData.detectorStatus === "failed"
                ? "NO CAMERA FEED"
                : "CAMERA STARTING...";
            }
          } else {
            renderer.setBoundaryPolygon(null);
            hudData.cameraWarning = null;
          }
        });

        unsubscribeXrFrame = context.events.on("xr/frame", (payload) => {
          if (xrRunning) {
            renderer.tick(payload.time);
          }
          labelManager.updateVisibility(options.camera);
          hudData.hudMode = debugHud.mode;
          debugHud.update(hudData, payload.time, options.camera);
        });

        unsubscribePerformance = context.events.on("app/performance", (payload) => {
          hudData.fps = payload.fps;
          hudData.avgFrameTimeMs = payload.avgFrameTimeMs;
          hudData.mode = payload.mode;
        });

        unsubscribeTrackingStatus = context.events.on("tracking/status", (payload) => {
          hudData.trackingBackend = payload.backend;
          hudData.detectorStatus = payload.detectorStatus;

          // Camera warning: show in XR mode when camera-worker backend can't get frames
          if (xrRunning && payload.backend === "camera-worker" && payload.detectorStatus === "failed") {
            hudData.cameraWarning = "NO CAMERA FEED";
          } else if (payload.backend === "camera-worker" && payload.detectorStatus === "ready") {
            hudData.cameraWarning = null;
          } else if (xrRunning && payload.backend === "camera-worker" && payload.detectorStatus !== "ready") {
            hudData.cameraWarning = "CAMERA STARTING...";
          }
        });

        unsubscribeHands = context.events.on("interaction/hands", (payload) => {
          handVisualizer.update(payload.hands);
          hudData.handsDetected = payload.hands.length;
          hudData.leftPinch = false;
          hudData.rightPinch = false;
          hudData.leftPinchStrength = 0;
          hudData.rightPinchStrength = 0;
          hudData.leftPoint = false;
          hudData.rightPoint = false;
          hudData.leftPointStrength = 0;
          hudData.rightPointStrength = 0;
          for (const h of payload.hands) {
            if (h.hand === "left") {
              hudData.leftPinch = h.pinching;
              hudData.leftPinchStrength = h.pinchStrength;
              hudData.leftPoint = h.pointing;
              hudData.leftPointStrength = h.pointStrength;
            } else {
              hudData.rightPinch = h.pinching;
              hudData.rightPinchStrength = h.pinchStrength;
              hudData.rightPoint = h.pointing;
              hudData.rightPointStrength = h.pointStrength;
            }
          }
        });

        // Pinch toggles HUD mode
        unsubscribePinch = context.events.on("interaction/pinch", (payload) => {
          if (payload.state === "start" && payload.hand === "left") {
            debugHud.toggleMode();
          }
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
      if (unsubscribeHands) {
        unsubscribeHands();
        unsubscribeHands = null;
      }
      if (unsubscribePinch) {
        unsubscribePinch();
        unsubscribePinch = null;
      }
      if (animationHandle) {
        window.cancelAnimationFrame(animationHandle);
        animationHandle = 0;
      }
      kmlMap.dispose();
      markerIndicators.dispose();
      handVisualizer.dispose();
      labelManager.dispose();
      debugHud.dispose();
      renderer.dispose();
    }
  };
}
