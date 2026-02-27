import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
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
import {
  selectRenderGraphView,
  selectTopologyStats,
  applyTopologyFilter,
  generateStressTopology,
  type TopologyFilterMode
} from "../topology";
import { SwitchableDetector } from "../tracking";
import kmlText from "../../docs/bombay-beach-feb-27-2026.kml?raw";

function toLabel(state: XrRuntimeState): string {
  return `XR state: ${state}`;
}

interface MarkerCalibrationState {
  firstSeenMs: number;
  lastSeenMs: number;
  confidence: number;
}

type CameraPermissionState = PermissionState | "unsupported" | "unknown";

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
  const isVrUi = window.matchMedia("(pointer: coarse)").matches;
  toolbar.style.display = "flex";
  toolbar.style.gap = isVrUi ? "12px" : "8px";
  toolbar.style.flexWrap = "wrap";
  toolbar.style.marginBottom = "8px";

  const applyControlButtonStyle = (
    button: HTMLButtonElement,
    options: { border: string; background: string; emphasis?: boolean }
  ): void => {
    button.style.padding = isVrUi ? "14px 20px" : "8px 12px";
    button.style.minHeight = isVrUi ? "56px" : "36px";
    button.style.minWidth = isVrUi ? (options.emphasis ? "240px" : "170px") : "0";
    button.style.fontSize = isVrUi ? (options.emphasis ? "19px" : "16px") : "14px";
    button.style.fontWeight = options.emphasis ? "700" : "600";
    button.style.borderRadius = isVrUi ? "12px" : "8px";
    button.style.border = options.border;
    button.style.background = options.background;
    button.style.color = "white";
    button.style.cursor = "pointer";
    button.style.touchAction = "manipulation";
  };

  const startButton = document.createElement("button");
  startButton.textContent = "Start AR Session";
  applyControlButtonStyle(startButton, {
    border: "1px solid #1e5f73",
    background: "#0f3b48",
    emphasis: true
  });

  const stopButton = document.createElement("button");
  stopButton.textContent = "Stop Session";
  applyControlButtonStyle(stopButton, {
    border: "1px solid #7a2a2a",
    background: "#5a1f1f"
  });

  const cameraTrackButton = document.createElement("button");
  cameraTrackButton.textContent = "Start Camera Tracking";
  applyControlButtonStyle(cameraTrackButton, {
    border: "1px solid #1e7353",
    background: "#0f4830"
  });

  const mockToggle = document.createElement("button");
  mockToggle.textContent = "Mode: Camera";
  applyControlButtonStyle(mockToggle, {
    border: "1px solid #4a4a6a",
    background: "#2a2a3f"
  });

  const filterBar = document.createElement("div");
  filterBar.style.display = "flex";
  filterBar.style.gap = isVrUi ? "10px" : "6px";
  filterBar.style.flexWrap = "wrap";
  filterBar.style.marginBottom = "8px";

  const filterModes: { label: string; mode: TopologyFilterMode }[] = [
    { label: "All", mode: "all" },
    { label: "Degraded", mode: "degraded" },
    { label: "Down", mode: "down" },
    { label: "High Latency", mode: "high-latency" },
    { label: "High Loss", mode: "high-loss" },
  ];

  let activeFilter: TopologyFilterMode = "all";

  const filterButtons: HTMLButtonElement[] = filterModes.map(({ label, mode }) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    applyControlButtonStyle(btn, {
      border: mode === "all" ? "1px solid #3e8fa8" : "1px solid #3a4a52",
      background: mode === "all" ? "#1a5568" : "#1a2428",
    });
    btn.style.fontSize = isVrUi ? "14px" : "12px";
    btn.style.padding = isVrUi ? "10px 16px" : "5px 10px";
    btn.style.minHeight = isVrUi ? "44px" : "28px";
    btn.style.minWidth = "0";
    return btn;
  });

  const updateFilterButtonStyles = (): void => {
    filterButtons.forEach((btn, i) => {
      const isActive = filterModes[i].mode === activeFilter;
      btn.style.border = isActive ? "1px solid #3e8fa8" : "1px solid #3a4a52";
      btn.style.background = isActive ? "#1a5568" : "#1a2428";
    });
  };

  filterButtons.forEach((btn, i) => {
    btn.addEventListener("click", () => {
      activeFilter = filterModes[i].mode;
      updateFilterButtonStyles();
    });
    filterBar.append(btn);
  });

  const stressToggle = document.createElement("button");
  stressToggle.textContent = "Stress: Off";
  applyControlButtonStyle(stressToggle, {
    border: "1px solid #6a3a6a",
    background: "#3f1f3f",
  });

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
  cameraStatsLabel.textContent = "Camera: idle";

  const cameraPermissionLabel = document.createElement("div");
  cameraPermissionLabel.style.fontSize = "12px";
  cameraPermissionLabel.style.opacity = "0.85";
  cameraPermissionLabel.textContent = "Camera permission: unknown";

  const cameraPiPLabel = document.createElement("div");
  cameraPiPLabel.style.fontSize = "12px";
  cameraPiPLabel.style.opacity = "0.85";
  cameraPiPLabel.textContent = "Camera PiP: no frame";

  const cameraPiPCanvas = document.createElement("canvas");
  cameraPiPCanvas.width = 320;
  cameraPiPCanvas.height = 180;
  cameraPiPCanvas.style.width = "320px";
  cameraPiPCanvas.style.height = "180px";
  cameraPiPCanvas.style.maxWidth = "100%";
  cameraPiPCanvas.style.borderRadius = "8px";
  cameraPiPCanvas.style.border = "1px solid rgba(88, 131, 144, 0.45)";
  cameraPiPCanvas.style.background = "#070c10";
  const cameraPiPCtx = cameraPiPCanvas.getContext("2d");

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

  toolbar.append(startButton, stopButton, cameraTrackButton, mockToggle, stressToggle);
  wrapper.append(
    toolbar,
    filterBar,
    stateLabel,
    frameStats,
    trackingStats,
    trackingBackendLabel,
    calibrationLabel,
    calibrationPanel,
    topologyStatsLabel,
    telemetryStatsLabel,
    cameraStatsLabel,
    cameraPermissionLabel,
    cameraPiPLabel,
    cameraPiPCanvas,
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

  const cameraPiPMesh = new Mesh(
    new PlaneGeometry(0.46, 0.26),
    new MeshBasicMaterial({
      color: "#101820",
      transparent: true,
      opacity: 0.96
    })
  );
  cameraPiPMesh.visible = false;
  cameraPiPMesh.position.set(0.55, 1.55, -1.05);
  cameraPiPMesh.name = "camera-pip";

  scene.add(ambient, keyLight, box, cameraPiPMesh);

  const xrRuntime = new XrRuntime(renderer);
  const events = createAppEventBus();
  const xrPerformance = new PerformanceMonitor();
  const desktopPerformance = new PerformanceMonitor();
  let lastPerfEmitMs = 0;
  const markerCalibration = new Map<number, MarkerCalibrationState>();
  let cameraPermissionState: CameraPermissionState = "unknown";
  let cameraPermissionStatus: PermissionStatus | null = null;

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

  const setCameraPermissionLabel = (state: CameraPermissionState): void => {
    cameraPermissionState = state;
    cameraPermissionLabel.textContent = `Camera permission: ${state}`;
    if (state === "granted") {
      cameraPermissionLabel.style.color = "#7be2b1";
      return;
    }
    if (state === "denied") {
      cameraPermissionLabel.style.color = "#ff9f9f";
      return;
    }
    cameraPermissionLabel.style.color = "#dbe5e8";
  };

  const refreshCameraPermissionState = async (): Promise<CameraPermissionState> => {
    if (!navigator.permissions || typeof navigator.permissions.query !== "function") {
      setCameraPermissionLabel("unsupported");
      return "unsupported";
    }

    try {
      const permissionStatus = await navigator.permissions.query({
        name: "camera" as PermissionName
      });
      if (cameraPermissionStatus !== permissionStatus) {
        if (cameraPermissionStatus) {
          cameraPermissionStatus.removeEventListener("change", onPermissionChange);
        }
        cameraPermissionStatus = permissionStatus;
        cameraPermissionStatus.addEventListener("change", onPermissionChange);
      }
      setCameraPermissionLabel(permissionStatus.state);
      return permissionStatus.state;
    } catch {
      setCameraPermissionLabel("unsupported");
      return "unsupported";
    }
  };

  const onPermissionChange = (): void => {
    if (!cameraPermissionStatus) {
      return;
    }
    setCameraPermissionLabel(cameraPermissionStatus.state);
  };

  events.on("app/error", (payload) => {
    frameStats.textContent = `[${payload.code}] ${payload.message}`;
  });

  await refreshCameraPermissionState();

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
  let cameraPiPTexture: VideoTexture | null = null;
  const xrCameraPos = new Vector3();
  const xrCameraQuat = new Quaternion();
  const pipOffset = new Vector3(0.34, -0.08, -0.68);

  const clearCameraPiPTexture = (): void => {
    if (!cameraPiPTexture) {
      return;
    }
    cameraPiPTexture.dispose();
    cameraPiPTexture = null;
    const material = cameraPiPMesh.material;
    if (material instanceof MeshBasicMaterial) {
      material.map = null;
      material.needsUpdate = true;
    }
    cameraPiPMesh.visible = false;
  };

  const updateInSceneCameraPiP = (inXrMode: boolean): void => {
    if (switchableDetector.getMode() !== "camera") {
      clearCameraPiPTexture();
      return;
    }

    const video = switchableDetector.camera.getVideo();
    if (!video || video.readyState < 2) {
      cameraPiPMesh.visible = false;
      return;
    }

    const material = cameraPiPMesh.material;
    if (!(material instanceof MeshBasicMaterial)) {
      return;
    }

    if (!cameraPiPTexture) {
      cameraPiPTexture = new VideoTexture(video);
      material.map = cameraPiPTexture;
      material.needsUpdate = true;
    }

    cameraPiPTexture.needsUpdate = true;
    cameraPiPMesh.visible = true;

    if (inXrMode) {
      const xrCamera = renderer.xr.getCamera();
      xrCamera.getWorldPosition(xrCameraPos);
      xrCamera.getWorldQuaternion(xrCameraQuat);
      const worldOffset = pipOffset.clone().applyQuaternion(xrCameraQuat);
      cameraPiPMesh.position.copy(xrCameraPos).add(worldOffset);
      cameraPiPMesh.quaternion.copy(xrCameraQuat);
    } else {
      cameraPiPMesh.position.set(0.55, 1.55, -1.05);
      cameraPiPMesh.quaternion.identity();
    }
  };

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
      updateInSceneCameraPiP(false);

      // Draw marker overlay
      if (overlayCtx && desktopTrackingActive && switchableDetector.getMode() === "camera") {
        drawMarkerOverlay(overlayCtx, overlayCanvas, switchableDetector);
      } else if (overlayCtx) {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      }

      if (cameraPiPCtx) {
        drawCameraPiP(cameraPiPCtx, cameraPiPCanvas, switchableDetector, cameraPiPLabel);
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
    updateInSceneCameraPiP(true);
    if (cameraPiPCtx) {
      drawCameraPiP(cameraPiPCtx, cameraPiPCanvas, switchableDetector, cameraPiPLabel);
    }
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

    if (payload.backend === "camera-worker") {
      cameraStatsLabel.textContent = `Camera: ${payload.detectorStatus}`;
      if (payload.detectorStatus === "ready" && cameraPermissionState === "unknown") {
        setCameraPermissionLabel("granted");
      }
    } else if (payload.backend === "mock") {
      cameraStatsLabel.textContent = "Camera: mock mode";
    }
  });

  events.on("topology/snapshot", (payload) => {
    const stats = selectTopologyStats(payload.snapshot);
    const renderView = selectRenderGraphView(payload.snapshot);
    const filtered = applyTopologyFilter(renderView, activeFilter);
    const filterSuffix = activeFilter !== "all"
      ? ` | filter "${activeFilter}": ${filtered.filteredNodeCount}N/${filtered.filteredLinkCount}L`
      : "";
    topologyStatsLabel.textContent =
      `Topology: ${stats.nodeCount} nodes / ${stats.linkCount} links` +
      ` | degraded N:${stats.degradedNodes} L:${stats.degradedLinks}` +
      filterSuffix;
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
      await refreshCameraPermissionState();

      if (switchableDetector.getMode() === "camera") {
        // Keep XR start independent from detector startup.
        // Detector startup happens from tracking frames, which matches
        // the known-good behavior in af3014 and avoids pre-start lockups.
        cameraStatsLabel.textContent = "Camera: waiting for XR detector start";
      }

      if (cameraPermissionState === "denied") {
        emitError(
          "CAMERA_PERMISSION_FAILED",
          "Camera permission denied. Marker tracking will not work with the camera detector.",
          true
        );
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

  cameraTrackButton.addEventListener("click", async () => {
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
      clearCameraPiPTexture();
      scene.background = defaultBackground;
    } else {
      desktopTrackingActive = true;
      await refreshCameraPermissionState();
      if (switchableDetector.getMode() === "camera") {
        try {
          await switchableDetector.camera.ensureStarted();
          cameraStatsLabel.textContent = "Camera: ready";
          if (cameraPermissionState !== "denied") {
            setCameraPermissionLabel("granted");
          }
        } catch {
          cameraStatsLabel.textContent = "Camera: failed to start";
          setCameraPermissionLabel("denied");
        }
      }
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
      clearCameraPiPTexture();
      scene.background = defaultBackground;
    } else {
      switchableDetector.setMode("camera");
      mockToggle.textContent = "Mode: Camera";
      mockToggle.style.border = "1px solid #4a4a6a";
      mockToggle.style.background = "#2a2a3f";
      // Video background will be picked up by the desktop loop
    }
  });

  let stressActive = false;
  stressToggle.addEventListener("click", () => {
    stressActive = !stressActive;
    if (stressActive) {
      stressToggle.textContent = "Stress: On (100/200)";
      stressToggle.style.border = "1px solid #a83e8f";
      stressToggle.style.background = "#5f1f4f";
      const stressSnapshot = generateStressTopology({ nodeCount: 100, linkCount: 200 });
      events.emit("topology/snapshot", {
        snapshot: stressSnapshot,
        timestampMs: performance.now(),
      });
    } else {
      stressToggle.textContent = "Stress: Off";
      stressToggle.style.border = "1px solid #6a3a6a";
      stressToggle.style.background = "#3f1f3f";
      // Re-emit the normal topology by triggering a fresh load
      // The topology agent will re-emit on next telemetry tick
      topologyStatsLabel.textContent = "Topology: reloading demo data...";
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
    clearCameraPiPTexture();
    if (cameraPermissionStatus) {
      cameraPermissionStatus.removeEventListener("change", onPermissionChange);
      cameraPermissionStatus = null;
    }
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

function drawCameraPiP(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  detector: import("../tracking").SwitchableDetector,
  label: HTMLDivElement
): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (detector.getMode() === "mock") {
    label.textContent = "Camera PiP: mock mode";
    drawPiPText(ctx, canvas, "Mock Mode");
    return;
  }

  const video = detector.camera.getVideo();
  const overlay = detector.camera.getOverlayData();

  if (!video || video.readyState < 2) {
    label.textContent = "Camera PiP: waiting for camera frame";
    drawPiPText(ctx, canvas, "Waiting for Camera...");
    return;
  }

  label.textContent =
    `Camera PiP: ${overlay.width}x${overlay.height} | detections ${overlay.detections.length}`;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const sx = canvas.width / overlay.width;
  const sy = canvas.height / overlay.height;

  for (const det of overlay.detections) {
    const corners = det.corners;
    if (!corners || corners.length < 4) {
      continue;
    }

    const isBest = det.markerId === overlay.bestId;
    ctx.beginPath();
    ctx.moveTo(corners[0].x * sx, corners[0].y * sy);
    for (let i = 1; i < corners.length; i++) {
      ctx.lineTo(corners[i].x * sx, corners[i].y * sy);
    }
    ctx.closePath();
    ctx.lineWidth = isBest ? 2.4 : 1.4;
    ctx.strokeStyle = isBest ? "#00ff88" : "#ffaa33";
    ctx.stroke();

    const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) * 0.25 * sx;
    const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) * 0.25 * sy;
    const text = `${det.markerId}`;
    ctx.font = "12px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const m = ctx.measureText(text);
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(cx - m.width / 2 - 4, cy - 8, m.width + 8, 16);
    ctx.fillStyle = isBest ? "#00ff88" : "#ffaa33";
    ctx.fillText(text, cx, cy);
  }
}

function drawPiPText(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  text: string
): void {
  ctx.fillStyle = "#070c10";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#9fb4be";
  ctx.font = "13px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
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
