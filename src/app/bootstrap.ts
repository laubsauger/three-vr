import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  VideoTexture,
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
import { SwitchableDetector } from "../tracking";
import kmlText from "../../docs/bombay-beach-feb-27-2026.kml?raw";

function toLabel(state: XrRuntimeState): string {
  return `XR state: ${state}`;
}

type CameraProbeState = "not-requested" | "granted" | "denied" | "unsupported";

interface MarkerCalibrationState {
  firstSeenMs: number;
  lastSeenMs: number;
  confidence: number;
}

async function requestEnvironmentCameraProbe(): Promise<CameraProbeState> {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    return "unsupported";
  }

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" }
      },
      audio: false
    });
    return "granted";
  } catch {
    return "denied";
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
  }
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

  const cameraTrackButton = document.createElement("button");
  cameraTrackButton.textContent = "Start Camera Tracking";
  cameraTrackButton.style.padding = "8px 12px";
  cameraTrackButton.style.borderRadius = "8px";
  cameraTrackButton.style.border = "1px solid #1e7353";
  cameraTrackButton.style.background = "#0f4830";
  cameraTrackButton.style.color = "white";
  cameraTrackButton.style.cursor = "pointer";

  const mockToggle = document.createElement("button");
  mockToggle.textContent = "Mode: Camera";
  mockToggle.style.padding = "8px 12px";
  mockToggle.style.borderRadius = "8px";
  mockToggle.style.border = "1px solid #4a4a6a";
  mockToggle.style.background = "#2a2a3f";
  mockToggle.style.color = "white";
  mockToggle.style.cursor = "pointer";

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

  const trackingBackendLabel = document.createElement("div");
  trackingBackendLabel.style.fontSize = "12px";
  trackingBackendLabel.style.opacity = "0.85";
  trackingBackendLabel.textContent = "Tracking backend: unknown";

  const calibrationLabel = document.createElement("div");
  calibrationLabel.style.fontSize = "12px";
  calibrationLabel.style.opacity = "0.9";
  calibrationLabel.style.marginTop = "6px";
  calibrationLabel.style.marginBottom = "2px";
  calibrationLabel.textContent = "Calibration: waiting for markers";

  const calibrationPanel = document.createElement("pre");
  calibrationPanel.style.margin = "0";
  calibrationPanel.style.padding = "8px";
  calibrationPanel.style.background = "rgba(8, 14, 18, 0.62)";
  calibrationPanel.style.border = "1px solid rgba(88, 131, 144, 0.4)";
  calibrationPanel.style.borderRadius = "8px";
  calibrationPanel.style.whiteSpace = "pre-wrap";
  calibrationPanel.style.fontSize = "12px";
  calibrationPanel.style.lineHeight = "1.4";
  calibrationPanel.textContent = "No marker observations yet.";

  const topologyStatsLabel = document.createElement("div");
  topologyStatsLabel.style.fontSize = "12px";
  topologyStatsLabel.style.opacity = "0.85";
  topologyStatsLabel.textContent = "Topology: not loaded";

  const telemetryStatsLabel = document.createElement("div");
  telemetryStatsLabel.style.fontSize = "12px";
  telemetryStatsLabel.style.opacity = "0.85";
  telemetryStatsLabel.textContent = "Telemetry: waiting for stream";

  const cameraStatsLabel = document.createElement("div");
  cameraStatsLabel.style.fontSize = "12px";
  cameraStatsLabel.style.opacity = "0.85";
  cameraStatsLabel.textContent = "Camera: not requested";

  const selectionStatsLabel = document.createElement("div");
  selectionStatsLabel.style.fontSize = "12px";
  selectionStatsLabel.style.opacity = "0.85";
  selectionStatsLabel.textContent = "Selection: none";

  const canvasHolder = document.createElement("div");
  canvasHolder.style.borderRadius = "12px";
  canvasHolder.style.overflow = "hidden";
  canvasHolder.style.border = "1px solid rgba(92, 128, 138, 0.4)";
  canvasHolder.style.position = "relative";

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.style.position = "absolute";
  overlayCanvas.style.top = "0";
  overlayCanvas.style.left = "0";
  overlayCanvas.style.width = "100%";
  overlayCanvas.style.height = "100%";
  overlayCanvas.style.pointerEvents = "none";
  const overlayCtx = overlayCanvas.getContext("2d");

  toolbar.append(startButton, stopButton, cameraTrackButton, mockToggle);
  wrapper.append(
    toolbar,
    stateLabel,
    frameStats,
    trackingStats,
    trackingBackendLabel,
    calibrationLabel,
    calibrationPanel,
    topologyStatsLabel,
    telemetryStatsLabel,
    cameraStatsLabel,
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
  canvasHolder.append(renderer.domElement, overlayCanvas);
  overlayCanvas.width = renderer.domElement.width;
  overlayCanvas.height = renderer.domElement.height;

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
  let cameraProbeState: CameraProbeState = "not-requested";
  const markerCalibration = new Map<number, MarkerCalibrationState>();

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

  const switchableDetector = new SwitchableDetector("camera");

  const integrationCoordinator = createIntegrationCoordinator(
    {
      events,
      xrRuntime
    },
    createDefaultAgentSuite({
      scene,
      camera,
      renderer,
      kmlText,
      detector: switchableDetector,
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
  let desktopTrackingActive = false;
  const defaultBackground = scene.background;
  let videoTexture: VideoTexture | null = null;

  const desktopLoop = (time: number): void => {
    if (xrRuntime.getState() !== "running") {
      const deltaMs = lastDesktopFrameTime === 0 ? 0 : time - lastDesktopFrameTime;
      lastDesktopFrameTime = time;
      if (deltaMs > 0) {
        desktopPerformance.recordFrame(time, deltaMs);
      }
      emitPerformance("desktop", time);

      if (desktopTrackingActive) {
        events.emit("xr/frame", {
          time,
          deltaMs,
          frame: null,
          referenceSpace: null,
        });

        // Attach camera feed as scene background once the video is ready
        if (!videoTexture && switchableDetector.getMode() === "camera") {
          const video = switchableDetector.camera.getVideo();
          if (video && video.readyState >= 2) {
            videoTexture = new VideoTexture(video);
            scene.background = videoTexture;
          }
        }
        if (videoTexture) {
          videoTexture.needsUpdate = true;
        }
      }

      // Draw marker overlay
      if (overlayCtx && desktopTrackingActive && switchableDetector.getMode() === "camera") {
        drawMarkerOverlay(overlayCtx, overlayCanvas, switchableDetector);
      } else if (overlayCtx) {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      }

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
    const now = payload.timestampMs;
    const markerIds = payload.markers.map((marker) => marker.markerId).join(", ");
    trackingStats.textContent =
      payload.markers.length > 0
        ? `Tracking markers: ${payload.markers.length} [${markerIds}]`
        : desktopTrackingActive
          ? "Tracking markers: 0 (scanning...)"
          : "Tracking markers: 0 (requires active XR session)";

    const visible = new Set<number>();
    for (const marker of payload.markers) {
      visible.add(marker.markerId);
      const existing = markerCalibration.get(marker.markerId);
      if (!existing) {
        markerCalibration.set(marker.markerId, {
          firstSeenMs: now,
          lastSeenMs: now,
          confidence: marker.pose.confidence
        });
      } else {
        existing.lastSeenMs = now;
        existing.confidence = marker.pose.confidence;
      }
    }

    for (const [markerId, state] of markerCalibration) {
      if (visible.has(markerId)) {
        continue;
      }
      if (now - state.lastSeenMs > 3000) {
        markerCalibration.delete(markerId);
      }
    }

    renderCalibrationPanel(calibrationLabel, calibrationPanel, markerCalibration, now);
  });

  events.on("tracking/status", (payload) => {
    trackingBackendLabel.textContent =
      `Tracking backend: ${payload.backend} (${payload.detectorStatus})`;
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
      if (cameraProbeState !== "granted") {
        cameraProbeState = await requestEnvironmentCameraProbe();
      }

      if (cameraProbeState === "granted") {
        cameraStatsLabel.textContent = "Camera: granted";
      } else if (cameraProbeState === "denied") {
        cameraStatsLabel.textContent = "Camera: denied";
        emitError(
          "CAMERA_PERMISSION_FAILED",
          "Camera permission denied. Marker tracking will not work with real camera detectors.",
          true
        );
      } else if (cameraProbeState === "unsupported") {
        cameraStatsLabel.textContent = "Camera: unsupported in this browser";
      } else {
        cameraStatsLabel.textContent = "Camera: not requested";
      }

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

  cameraTrackButton.addEventListener("click", () => {
    if (desktopTrackingActive) {
      desktopTrackingActive = false;
      cameraTrackButton.textContent = "Start Camera Tracking";
      cameraTrackButton.style.border = "1px solid #1e7353";
      cameraTrackButton.style.background = "#0f4830";
      trackingStats.textContent = "Tracking markers: 0";

      // Restore default background
      if (videoTexture) {
        videoTexture.dispose();
        videoTexture = null;
      }
      scene.background = defaultBackground;
    } else {
      desktopTrackingActive = true;
      cameraTrackButton.textContent = "Stop Camera Tracking";
      cameraTrackButton.style.border = "1px solid #7a6a2a";
      cameraTrackButton.style.background = "#5a4a1f";
      trackingStats.textContent =
        switchableDetector.getMode() === "mock"
          ? "Tracking markers: 0 (mock active)"
          : "Tracking markers: 0 (starting camera...)";
    }
  });

  mockToggle.addEventListener("click", () => {
    if (switchableDetector.getMode() === "camera") {
      switchableDetector.setMode("mock");
      mockToggle.textContent = "Mode: Mock";
      mockToggle.style.border = "1px solid #6a5a2a";
      mockToggle.style.background = "#3f3520";
      // Drop video background in mock mode
      if (videoTexture) {
        videoTexture.dispose();
        videoTexture = null;
      }
      scene.background = defaultBackground;
    } else {
      switchableDetector.setMode("camera");
      mockToggle.textContent = "Mode: Camera";
      mockToggle.style.border = "1px solid #4a4a6a";
      mockToggle.style.background = "#2a2a3f";
      // Video background will be picked up by the desktop loop
    }
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / Math.max(window.innerHeight, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight * 0.75);
    overlayCanvas.width = renderer.domElement.width;
    overlayCanvas.height = renderer.domElement.height;
  });

  window.addEventListener("beforeunload", () => {
    void integrationCoordinator.disposeAll();
  });

  setState();
}

function renderCalibrationPanel(
  label: HTMLDivElement,
  panel: HTMLPreElement,
  markerCalibration: Map<number, MarkerCalibrationState>,
  nowMs: number
): void {
  const rows = [...markerCalibration.entries()]
    .sort((a, b) => b[1].confidence - a[1].confidence)
    .slice(0, 8);

  if (rows.length === 0) {
    label.textContent = "Calibration: waiting for markers";
    panel.textContent = "No marker observations yet.";
    return;
  }

  let readyCount = 0;
  const lines = rows.map(([markerId, state]) => {
    const lockMs = Math.max(0, nowMs - state.firstSeenMs);
    if (state.confidence >= 0.72 && lockMs >= 1200) {
      readyCount++;
    }
    return (
      `ID ${markerId} | conf ${state.confidence.toFixed(2)} | lock ${(lockMs / 1000).toFixed(1)}s` +
      ` | age ${((nowMs - state.lastSeenMs) / 1000).toFixed(1)}s`
    );
  });

  if (readyCount > 0) {
    label.textContent = `Calibration: ready (${readyCount} stable marker${readyCount > 1 ? "s" : ""})`;
  } else {
    label.textContent = "Calibration: acquiring stable marker lock";
  }
  panel.textContent = lines.join("\n");
}

function drawMarkerOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  detector: import("../tracking").SwitchableDetector
): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const overlay = detector.camera.getOverlayData();
  if (overlay.detections.length === 0) return;

  // Scale from detector capture coords → overlay canvas coords
  const sx = canvas.width / overlay.width;
  const sy = canvas.height / overlay.height;

  for (const det of overlay.detections) {
    const corners = det.corners;
    if (!corners || corners.length < 4) continue;

    const isBest = det.markerId === overlay.bestId;

    // Draw quad outline
    ctx.beginPath();
    ctx.moveTo(corners[0].x * sx, corners[0].y * sy);
    for (let i = 1; i < corners.length; i++) {
      ctx.lineTo(corners[i].x * sx, corners[i].y * sy);
    }
    ctx.closePath();

    ctx.lineWidth = isBest ? 3 : 1.5;
    ctx.strokeStyle = isBest ? "#00ff88" : "#ffaa33";
    ctx.stroke();

    // Fill with translucent highlight
    ctx.fillStyle = isBest ? "rgba(0, 255, 136, 0.12)" : "rgba(255, 170, 51, 0.08)";
    ctx.fill();

    // Draw corner dots
    for (const corner of corners) {
      ctx.beginPath();
      ctx.arc(corner.x * sx, corner.y * sy, isBest ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isBest ? "#00ff88" : "#ffaa33";
      ctx.fill();
    }

    // ID label
    const cx = corners.reduce((s, c) => s + c.x, 0) / corners.length * sx;
    const cy = corners.reduce((s, c) => s + c.y, 0) / corners.length * sy;

    const label = `ID ${det.markerId}`;
    ctx.font = isBest ? "bold 16px monospace" : "12px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Background pill
    const metrics = ctx.measureText(label);
    const pw = metrics.width + 12;
    const ph = isBest ? 22 : 18;
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.beginPath();
    ctx.roundRect(cx - pw / 2, cy - ph / 2, pw, ph, 4);
    ctx.fill();

    ctx.fillStyle = isBest ? "#00ff88" : "#ffaa33";
    ctx.fillText(label, cx, cy);

    // Confidence badge for best
    if (isBest) {
      const confLabel = `${(det.confidence * 100).toFixed(0)}%`;
      ctx.font = "11px monospace";
      const confY = cy + ph / 2 + 12;
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      const cm = ctx.measureText(confLabel);
      ctx.beginPath();
      ctx.roundRect(cx - cm.width / 2 - 4, confY - 7, cm.width + 8, 14, 3);
      ctx.fill();
      ctx.fillStyle = "#00ff88";
      ctx.fillText(confLabel, cx, confY);
    }
  }
}
