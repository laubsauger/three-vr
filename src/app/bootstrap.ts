import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer
} from "three";

import { XrRuntime } from "../xr-core";
import type { XrRuntimeState } from "../contracts/xr";
import { createAppEventBus } from "./event-bus";
import type { AppErrorCode } from "../contracts/events";
import { PerformanceMonitor } from "./performance-monitor";
import { createDefaultAgentSuite } from "./agent-suite";
import { createIntegrationCoordinator } from "./integration";
import { selectRenderGraphView, selectTopologyStats } from "../topology";

function toLabel(state: XrRuntimeState): string {
  return `XR state: ${state}`;
}

export async function bootstrapApp(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    throw new Error("Missing #app root element.");
  }

  const wrapper = document.createElement("div");
  wrapper.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
  wrapper.style.padding = "12px";
  wrapper.style.color = "#dbe5e8";
  wrapper.style.background = "linear-gradient(160deg, #0a1014 0%, #101f26 100%)";
  wrapper.style.minHeight = "100vh";
  wrapper.style.boxSizing = "border-box";

  const toolbar = document.createElement("div");
  toolbar.style.display = "flex";
  toolbar.style.gap = "8px";
  toolbar.style.flexWrap = "wrap";
  toolbar.style.marginBottom = "8px";

  const startButton = document.createElement("button");
  startButton.textContent = "Start AR Session";
  startButton.style.padding = "8px 12px";
  startButton.style.borderRadius = "8px";
  startButton.style.border = "1px solid #1e5f73";
  startButton.style.background = "#0f3b48";
  startButton.style.color = "white";
  startButton.style.cursor = "pointer";

  const stopButton = document.createElement("button");
  stopButton.textContent = "Stop Session";
  stopButton.style.padding = "8px 12px";
  stopButton.style.borderRadius = "8px";
  stopButton.style.border = "1px solid #7a2a2a";
  stopButton.style.background = "#5a1f1f";
  stopButton.style.color = "white";
  stopButton.style.cursor = "pointer";

  const stateLabel = document.createElement("div");
  stateLabel.style.fontSize = "14px";
  stateLabel.style.padding = "8px 0";
  stateLabel.textContent = toLabel("idle");

  const capabilitiesLabel = document.createElement("pre");
  capabilitiesLabel.style.margin = "0";
  capabilitiesLabel.style.padding = "8px";
  capabilitiesLabel.style.background = "rgba(9, 16, 21, 0.6)";
  capabilitiesLabel.style.border = "1px solid rgba(90, 129, 140, 0.4)";
  capabilitiesLabel.style.borderRadius = "8px";
  capabilitiesLabel.style.whiteSpace = "pre-wrap";
  capabilitiesLabel.style.fontSize = "12px";

  const frameStats = document.createElement("div");
  frameStats.style.fontSize = "12px";
  frameStats.style.opacity = "0.85";
  frameStats.style.marginBottom = "4px";

  const trackingStats = document.createElement("div");
  trackingStats.style.fontSize = "12px";
  trackingStats.style.opacity = "0.85";
  trackingStats.textContent = "Tracking markers: 0";

  const topologyStatsLabel = document.createElement("div");
  topologyStatsLabel.style.fontSize = "12px";
  topologyStatsLabel.style.opacity = "0.85";
  topologyStatsLabel.textContent = "Topology: not loaded";

  const telemetryStatsLabel = document.createElement("div");
  telemetryStatsLabel.style.fontSize = "12px";
  telemetryStatsLabel.style.opacity = "0.85";
  telemetryStatsLabel.textContent = "Telemetry: waiting for stream";

  const selectionStatsLabel = document.createElement("div");
  selectionStatsLabel.style.fontSize = "12px";
  selectionStatsLabel.style.opacity = "0.85";
  selectionStatsLabel.textContent = "Selection: none";

  const canvasHolder = document.createElement("div");
  canvasHolder.style.borderRadius = "12px";
  canvasHolder.style.overflow = "hidden";
  canvasHolder.style.border = "1px solid rgba(92, 128, 138, 0.4)";

  toolbar.append(startButton, stopButton);
  wrapper.append(
    toolbar,
    stateLabel,
    frameStats,
    trackingStats,
    topologyStatsLabel,
    telemetryStatsLabel,
    selectionStatsLabel,
    capabilitiesLabel,
    canvasHolder
  );
  root.append(wrapper);

  const scene = new Scene();
  scene.background = new Color("#091419");

  const camera = new PerspectiveCamera(
    70,
    window.innerWidth / Math.max(window.innerHeight, 1),
    0.01,
    100
  );
  camera.position.set(0, 1.4, 2.5);

  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight * 0.75);
  canvasHolder.append(renderer.domElement);

  const ambient = new AmbientLight(0xffffff, 0.5);
  const keyLight = new DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(2, 4, 3);

  const box = new Mesh(
    new BoxGeometry(0.35, 0.35, 0.35),
    new MeshStandardMaterial({ color: "#25a9d6" })
  );
  box.position.set(0, 1.35, -1.3);

  scene.add(ambient, keyLight, box);

  const xrRuntime = new XrRuntime(renderer);
  const events = createAppEventBus();
  const xrPerformance = new PerformanceMonitor();
  const desktopPerformance = new PerformanceMonitor();
  let lastPerfEmitMs = 0;

  const emitError = (
    code: AppErrorCode,
    message: string,
    recoverable: boolean,
    details?: Record<string, unknown>
  ): void => {
    events.emit("app/error", {
      code,
      source: "xr-core",
      message,
      recoverable,
      timestampMs: performance.now(),
      details
    });
  };

  events.on("app/error", (payload) => {
    frameStats.textContent = `[${payload.code}] ${payload.message}`;
  });

  const integrationCoordinator = createIntegrationCoordinator(
    {
      events,
      xrRuntime
    },
    createDefaultAgentSuite({
      scene,
      camera,
      renderer
    })
  );

  try {
    await integrationCoordinator.initAll();
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    emitError("INTEGRATION_CONFLICT", `Failed to initialize integration agents: ${details}`, true);
  }

  const capabilities = await xrRuntime.detectCapabilities();
  events.emit("xr/capabilities", {
    capabilities,
    timestampMs: performance.now()
  });
  capabilitiesLabel.textContent = `Capabilities\n${JSON.stringify(capabilities, null, 2)}`;

  const setState = (): void => {
    const state = xrRuntime.getState();
    events.emit("xr/state", {
      state,
      timestampMs: performance.now()
    });
    stateLabel.textContent = toLabel(state);
    startButton.disabled = state === "running" || state === "requesting";
    stopButton.disabled = state !== "running";
  };

  const emitPerformance = (mode: "xr" | "desktop", nowMs: number): void => {
    const intervalMs = 500;
    if (nowMs - lastPerfEmitMs < intervalMs) {
      return;
    }
    lastPerfEmitMs = nowMs;

    const snapshot =
      mode === "xr" ? xrPerformance.getSnapshot(nowMs) : desktopPerformance.getSnapshot(nowMs);

    events.emit("app/performance", {
      mode,
      fps: snapshot.fps,
      avgFrameTimeMs: snapshot.avgFrameTimeMs,
      p95FrameTimeMs: snapshot.p95FrameTimeMs,
      sampleSize: snapshot.sampleSize,
      timestampMs: nowMs
    });
  };

  let desktopLoopHandle = 0;
  const desktopLoop = (time: number): void => {
    if (xrRuntime.getState() !== "running") {
      const deltaMs = lastDesktopFrameTime === 0 ? 0 : time - lastDesktopFrameTime;
      lastDesktopFrameTime = time;
      if (deltaMs > 0) {
        desktopPerformance.recordFrame(time, deltaMs);
      }
      emitPerformance("desktop", time);
      box.rotation.y = time * 0.00035;
      box.rotation.x = time * 0.0002;
      renderer.render(scene, camera);
      desktopLoopHandle = window.requestAnimationFrame(desktopLoop);
    }
  };
  let lastDesktopFrameTime = 0;
  desktopLoopHandle = window.requestAnimationFrame(desktopLoop);

  xrRuntime.subscribeFrame((tick) => {
    if (tick.deltaMs > 0) {
      xrPerformance.recordFrame(tick.time, tick.deltaMs);
    }
    emitPerformance("xr", tick.time);
    events.emit("xr/frame", tick);
    box.rotation.y += 0.01;
    box.rotation.x += 0.004;
    const snapshot = xrPerformance.getSnapshot(tick.time);
    frameStats.textContent = `XR ${snapshot.fps.toFixed(1)} FPS | avg ${snapshot.avgFrameTimeMs.toFixed(2)}ms | p95 ${snapshot.p95FrameTimeMs.toFixed(2)}ms`;
    renderer.render(scene, camera);
    setState();
  });

  events.on("app/performance", (payload) => {
    if (payload.mode !== "desktop" || xrRuntime.getState() === "running") {
      return;
    }

    frameStats.textContent = `Desktop ${payload.fps.toFixed(1)} FPS | avg ${payload.avgFrameTimeMs.toFixed(2)}ms | p95 ${payload.p95FrameTimeMs.toFixed(2)}ms`;
  });

  events.on("tracking/markers", (payload) => {
    const markerIds = payload.markers.map((marker) => marker.markerId).join(", ");
    trackingStats.textContent =
      payload.markers.length > 0
        ? `Tracking markers: ${payload.markers.length} [${markerIds}]`
        : "Tracking markers: 0";
  });

  events.on("topology/snapshot", (payload) => {
    const stats = selectTopologyStats(payload.snapshot);
    const renderView = selectRenderGraphView(payload.snapshot);
    topologyStatsLabel.textContent =
      `Topology: ${stats.nodeCount} nodes / ${stats.linkCount} links` +
      ` | degraded N:${stats.degradedNodes} L:${stats.degradedLinks}` +
      ` | render graph ${renderView.nodes.length}/${renderView.links.length}`;
  });

  events.on("telemetry/update", (payload) => {
    telemetryStatsLabel.textContent =
      `Telemetry ${payload.source}:` +
      ` node updates ${payload.changedNodeIds.length}, link updates ${payload.changedLinkIds.length}`;
  });

  events.on("interaction/selection-change", (payload) => {
    if (payload.selectedNodeId) {
      selectionStatsLabel.textContent = `Selection: node ${payload.selectedNodeId}`;
      return;
    }
    if (payload.selectedLinkId) {
      selectionStatsLabel.textContent = `Selection: link ${payload.selectedLinkId}`;
      return;
    }
    selectionStatsLabel.textContent = "Selection: none";
  });

  startButton.addEventListener("click", async () => {
    try {
      await xrRuntime.start({
        mode: "immersive-ar",
        domOverlayRoot: wrapper
      });
      if (desktopLoopHandle) {
        window.cancelAnimationFrame(desktopLoopHandle);
        desktopLoopHandle = 0;
      }
      setState();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      emitError("XR_SESSION_START_FAILED", `Failed to start XR session: ${details}`, true, {
        mode: "immersive-ar"
      });
      setState();
    }
  });

  stopButton.addEventListener("click", async () => {
    try {
      await xrRuntime.stop();
      if (!desktopLoopHandle) {
        lastDesktopFrameTime = 0;
        desktopLoopHandle = window.requestAnimationFrame(desktopLoop);
      }
      setState();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      emitError("XR_SESSION_STOP_FAILED", `Failed to stop XR session: ${details}`, true);
      setState();
    }
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / Math.max(window.innerHeight, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight * 0.75);
  });

  window.addEventListener("beforeunload", () => {
    void integrationCoordinator.disposeAll();
  });

  setState();
}
