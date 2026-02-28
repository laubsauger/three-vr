import {
  AmbientLight,
  CanvasTexture,
  Color,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  VideoTexture,
  WebGLRenderer
} from "three";

import { XrRuntime } from "../xr-core";
import type { XrCapabilities, XrReferenceSpaceType, XrRuntimeState } from "../contracts/xr";
import { createAppEventBus } from "./event-bus";
import type { AppErrorCode } from "../contracts/events";
import type { TrackedMarker } from "../contracts/domain";
import { PerformanceMonitor } from "./performance-monitor";
import { createDefaultAgentSuite } from "./agent-suite";
import { createIntegrationCoordinator } from "./integration";
import { HandheldScreenController } from "./handheld-screen";
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

interface LockedSpawnAnchorState {
  markerId: number;
  worldPosition: Vector3;
  worldRotation: Quaternion;
  relativePosition: Vector3;
  relativeRotation: Quaternion;
}

type CameraPermissionState = PermissionState | "unsupported" | "unknown";
type XrCameraAccessState = "unknown" | "probing" | "required" | "fallback" | "standard";
type XrEntryMode = "prelock" | "passthrough";

export async function bootstrapApp(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    throw new Error("Missing #app root element.");
  }
  document.body.style.margin = "0";
  root.style.minHeight = "100vh";

  const isVrUi = window.matchMedia("(pointer: coarse)").matches;
  const wrapper = document.createElement("div");
  wrapper.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
  wrapper.style.padding = isVrUi ? "16px" : "14px";
  wrapper.style.color = "#dbe5e8";
  wrapper.style.background = "radial-gradient(circle at top right, rgba(42, 112, 134, 0.18), transparent 34%), linear-gradient(160deg, #0a1014 0%, #101f26 58%, #0d171c 100%)";
  wrapper.style.minHeight = "100vh";
  wrapper.style.boxSizing = "border-box";
  wrapper.style.maxWidth = "1220px";
  wrapper.style.margin = "0 auto";
  wrapper.style.display = "grid";
  wrapper.style.gap = isVrUi ? "12px" : "10px";

  const toolbar = document.createElement("div");
  toolbar.style.display = "flex";
  toolbar.style.gap = isVrUi ? "12px" : "10px";
  toolbar.style.flexWrap = "wrap";
  toolbar.style.padding = isVrUi ? "10px" : "8px";
  toolbar.style.borderRadius = "14px";
  toolbar.style.background = "rgba(7, 14, 18, 0.74)";
  toolbar.style.border = "1px solid rgba(84, 126, 138, 0.34)";
  toolbar.style.backdropFilter = "blur(10px)";

  const applyControlButtonStyle = (
    button: HTMLButtonElement,
    options: { border: string; background: string; emphasis?: boolean }
  ): void => {
    button.style.padding = isVrUi ? "16px 22px" : (options.emphasis ? "12px 18px" : "10px 14px");
    button.style.minHeight = isVrUi ? "64px" : (options.emphasis ? "46px" : "42px");
    button.style.minWidth = isVrUi ? (options.emphasis ? "248px" : "182px") : (options.emphasis ? "168px" : "138px");
    button.style.fontSize = isVrUi ? (options.emphasis ? "19px" : "16px") : (options.emphasis ? "15px" : "13px");
    button.style.fontWeight = options.emphasis ? "700" : "600";
    button.style.borderRadius = isVrUi ? "14px" : "10px";
    button.style.border = options.border;
    button.style.background = options.background;
    button.style.color = "white";
    button.style.cursor = "pointer";
    button.style.touchAction = "manipulation";
    button.style.boxShadow = "inset 0 1px 0 rgba(255,255,255,0.06)";
    button.style.letterSpacing = "0.02em";
  };

  const metricFontFamily =
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace";
  const applyMetricLineStyle = (element: HTMLElement): void => {
    element.style.fontFamily = metricFontFamily;
    element.style.fontVariantNumeric = "tabular-nums";
    element.style.lineHeight = "1.35";
    element.style.minHeight = "1.35em";
  };
  const applyMetricBlockStyle = (element: HTMLElement, minLines: number): void => {
    applyMetricLineStyle(element);
    element.style.whiteSpace = "pre-wrap";
    element.style.minHeight = `${(minLines * 1.35).toFixed(2)}em`;
  };

  const xrOverlayRoot = document.createElement("div");
  xrOverlayRoot.style.position = "fixed";
  xrOverlayRoot.style.inset = "0";
  xrOverlayRoot.style.display = "none";
  xrOverlayRoot.style.pointerEvents = "none";
  xrOverlayRoot.style.background = "transparent";
  xrOverlayRoot.style.zIndex = "2000";

  const xrOverlayBar = document.createElement("div");
  xrOverlayBar.style.position = "absolute";
  xrOverlayBar.style.top = "max(12px, env(safe-area-inset-top))";
  xrOverlayBar.style.left = "12px";
  xrOverlayBar.style.right = "12px";
  xrOverlayBar.style.display = "flex";
  xrOverlayBar.style.alignItems = "center";
  xrOverlayBar.style.justifyContent = "space-between";
  xrOverlayBar.style.gap = "12px";
  xrOverlayBar.style.padding = "8px 10px";
  xrOverlayBar.style.borderRadius = "12px";
  xrOverlayBar.style.background = "rgba(5, 10, 13, 0.32)";
  xrOverlayBar.style.border = "1px solid rgba(84, 126, 138, 0.2)";
  xrOverlayBar.style.backdropFilter = "blur(8px)";
  xrOverlayBar.style.pointerEvents = "auto";

  const xrOverlayLabel = document.createElement("div");
  xrOverlayLabel.textContent = "AR session active";
  xrOverlayLabel.style.fontSize = "12px";
  xrOverlayLabel.style.fontWeight = "700";
  xrOverlayLabel.style.letterSpacing = "0.04em";
  xrOverlayLabel.style.color = "#dbe5e8";

  const xrOverlayStopButton = document.createElement("button");
  xrOverlayStopButton.type = "button";
  xrOverlayStopButton.textContent = "Stop AR";
  applyControlButtonStyle(xrOverlayStopButton, {
    border: "1px solid #7a2a2a",
    background: "#5a1f1f"
  });
  xrOverlayStopButton.style.minWidth = "0";
  xrOverlayStopButton.style.minHeight = isVrUi ? "52px" : "40px";
  xrOverlayStopButton.style.padding = isVrUi ? "12px 18px" : "9px 12px";

  xrOverlayBar.append(xrOverlayLabel, xrOverlayStopButton);
  xrOverlayRoot.append(xrOverlayBar);

  const createInfoCard = (
    title: string,
    options: { collapsible?: boolean; collapsed?: boolean } = {}
  ): {
    card: HTMLDivElement;
    body: HTMLDivElement;
    setCollapsed: (collapsed: boolean) => void;
  } => {
    const card = document.createElement("div");
    card.style.display = "grid";
    card.style.gap = "8px";
    card.style.padding = isVrUi ? "12px" : "10px";
    card.style.borderRadius = "14px";
    card.style.background = "rgba(7, 14, 18, 0.7)";
    card.style.border = "1px solid rgba(84, 126, 138, 0.28)";
    card.style.boxShadow = "inset 0 1px 0 rgba(255,255,255,0.04)";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "10px";

    const heading = document.createElement("div");
    heading.textContent = title;
    heading.style.fontSize = "11px";
    heading.style.fontWeight = "700";
    heading.style.letterSpacing = "0.08em";
    heading.style.textTransform = "uppercase";
    heading.style.color = "#8eb6c1";
    heading.style.opacity = "0.92";
    header.append(heading);

    const body = document.createElement("div");
    body.style.display = "grid";
    body.style.gap = "6px";

    let toggleButton: HTMLButtonElement | null = null;
    const setCollapsed = (collapsed: boolean): void => {
      body.style.display = collapsed ? "none" : "grid";
      if (toggleButton) {
        toggleButton.textContent = collapsed ? "Show" : "Hide";
      }
    };

    if (options.collapsible) {
      toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.style.padding = isVrUi ? "8px 12px" : "4px 8px";
      toggleButton.style.minHeight = isVrUi ? "36px" : "24px";
      toggleButton.style.borderRadius = "999px";
      toggleButton.style.border = "1px solid rgba(92, 128, 138, 0.32)";
      toggleButton.style.background = "rgba(11, 22, 28, 0.7)";
      toggleButton.style.color = "#8eb6c1";
      toggleButton.style.fontSize = isVrUi ? "12px" : "11px";
      toggleButton.style.fontWeight = "700";
      toggleButton.style.cursor = "pointer";
      toggleButton.style.touchAction = "manipulation";
      toggleButton.addEventListener("click", () => {
        setCollapsed(body.style.display !== "none");
      });
      header.append(toggleButton);
    }

    card.append(header, body);
    setCollapsed(Boolean(options.collapsed));
    return { card, body, setCollapsed };
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
  stopButton.style.opacity = "0.5";

  const cameraTrackButton = document.createElement("button");
  cameraTrackButton.textContent = "Stop Camera Tracking";
  applyControlButtonStyle(cameraTrackButton, {
    border: "1px solid #7a6a2a",
    background: "#5a4a1f"
  });

  const mockToggle = document.createElement("button");
  mockToggle.textContent = "Mode: Camera";
  applyControlButtonStyle(mockToggle, {
    border: "1px solid #4a4a6a",
    background: "#2a2a3f"
  });

  const xrEntryModeToggle = document.createElement("button");
  applyControlButtonStyle(xrEntryModeToggle, {
    border: "1px solid #6a5a2a",
    background: "#3f3520"
  });
  xrEntryModeToggle.style.minWidth = isVrUi ? "220px" : "0";

  const filterBar = document.createElement("div");
  filterBar.style.display = "flex";
  filterBar.style.gap = isVrUi ? "10px" : "6px";
  filterBar.style.flexWrap = "wrap";
  filterBar.style.padding = isVrUi ? "8px 10px" : "6px 8px";
  filterBar.style.borderRadius = "12px";
  filterBar.style.background = "rgba(10, 18, 22, 0.56)";
  filterBar.style.border = "1px solid rgba(62, 88, 96, 0.26)";

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
    btn.style.padding = isVrUi ? "11px 16px" : "7px 10px";
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
  stateLabel.style.fontWeight = "700";
  stateLabel.textContent = toLabel("idle");

  const environmentLabel = document.createElement("div");
  environmentLabel.style.fontSize = "12px";
  environmentLabel.style.opacity = "0.85";
  environmentLabel.textContent = "Context: probing runtime environment";

  const arStartPathLabel = document.createElement("div");
  arStartPathLabel.style.fontSize = "12px";
  arStartPathLabel.style.opacity = "0.9";
  arStartPathLabel.textContent = "AR start path: idle";

  const arStartDetailLabel = document.createElement("pre");
  arStartDetailLabel.style.margin = "0";
  arStartDetailLabel.style.padding = "8px";
  arStartDetailLabel.style.background = "rgba(8, 14, 18, 0.62)";
  arStartDetailLabel.style.border = "1px solid rgba(88, 131, 144, 0.28)";
  arStartDetailLabel.style.borderRadius = "8px";
  arStartDetailLabel.style.whiteSpace = "pre-wrap";
  arStartDetailLabel.style.fontSize = "11px";
  arStartDetailLabel.style.lineHeight = "1.35";
  arStartDetailLabel.style.maxHeight = "120px";
  arStartDetailLabel.style.overflow = "auto";
  arStartDetailLabel.textContent = "No AR startup attempts yet.";

  const capabilitiesLabel = document.createElement("pre");
  capabilitiesLabel.style.margin = "0";
  capabilitiesLabel.style.padding = "8px";
  capabilitiesLabel.style.background = "rgba(9, 16, 21, 0.48)";
  capabilitiesLabel.style.border = "1px solid rgba(90, 129, 140, 0.24)";
  capabilitiesLabel.style.borderRadius = "8px";
  capabilitiesLabel.style.whiteSpace = "pre-wrap";
  capabilitiesLabel.style.fontSize = "12px";
  capabilitiesLabel.style.maxWidth = "320px";

  const frameStats = document.createElement("div");
  frameStats.style.fontSize = "12px";
  frameStats.style.opacity = "0.85";
  frameStats.style.marginBottom = "4px";

  const trackingStats = document.createElement("div");
  trackingStats.style.fontSize = "12px";
  trackingStats.style.opacity = "0.85";
  trackingStats.textContent = "Tracking markers: 0 (scanning...)";

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

  const spawnAnchorLabel = document.createElement("div");
  spawnAnchorLabel.style.fontSize = "12px";
  spawnAnchorLabel.style.opacity = "0.9";
  spawnAnchorLabel.style.marginBottom = "2px";
  spawnAnchorLabel.textContent = "Spawn anchor: waiting for stable marker";

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

  const xrCameraAccessLabel = document.createElement("div");
  xrCameraAccessLabel.style.fontSize = "12px";
  xrCameraAccessLabel.style.opacity = "0.85";
  xrCameraAccessLabel.textContent = "XR camera-access: unknown";

  const cameraPiPLabel = document.createElement("div");
  cameraPiPLabel.style.fontSize = "12px";
  cameraPiPLabel.style.opacity = "0.85";
  cameraPiPLabel.textContent = "Camera PiP: no frame";

  const cameraPiPCanvas = document.createElement("canvas");
  cameraPiPCanvas.width = 280;
  cameraPiPCanvas.height = 158;
  cameraPiPCanvas.style.width = "280px";
  cameraPiPCanvas.style.height = "158px";
  cameraPiPCanvas.style.maxWidth = "100%";
  cameraPiPCanvas.style.borderRadius = "8px";
  cameraPiPCanvas.style.border = "1px solid rgba(88, 131, 144, 0.45)";
  cameraPiPCanvas.style.background = "#070c10";
  const cameraPiPCtx = cameraPiPCanvas.getContext("2d");
  const inScenePiPCanvas = document.createElement("canvas");
  inScenePiPCanvas.width = cameraPiPCanvas.width;
  inScenePiPCanvas.height = cameraPiPCanvas.height;
  const inScenePiPCtx = inScenePiPCanvas.getContext("2d");

  const selectionStatsLabel = document.createElement("div");
  selectionStatsLabel.style.fontSize = "12px";
  selectionStatsLabel.style.opacity = "0.85";
  selectionStatsLabel.textContent = "Selection: none";
  [
    environmentLabel,
    arStartPathLabel,
    frameStats,
    trackingStats,
    trackingBackendLabel,
    calibrationLabel,
    spawnAnchorLabel,
    topologyStatsLabel,
    telemetryStatsLabel,
    cameraStatsLabel,
    cameraPermissionLabel,
    xrCameraAccessLabel,
    selectionStatsLabel
  ].forEach(applyMetricLineStyle);
  applyMetricBlockStyle(cameraPiPLabel, 4);

  const canvasHolder = document.createElement("div");
  canvasHolder.style.borderRadius = "16px";
  canvasHolder.style.overflow = "hidden";
  canvasHolder.style.border = "1px solid rgba(92, 128, 138, 0.34)";
  canvasHolder.style.position = "relative";
  canvasHolder.style.background = "rgba(4, 9, 12, 0.45)";
  canvasHolder.style.boxShadow = "0 14px 34px rgba(0, 0, 0, 0.24)";

  const statusGrid = document.createElement("div");
  statusGrid.style.display = "grid";
  statusGrid.style.gridTemplateColumns = "repeat(auto-fit, minmax(240px, 1fr))";
  statusGrid.style.gap = isVrUi ? "12px" : "10px";
  statusGrid.style.alignItems = "start";

  const sessionCard = createInfoCard("Session");
  const anchorCard = createInfoCard("Anchoring");
  const cameraCard = createInfoCard("Camera", { collapsible: true });
  const telemetryCard = createInfoCard("Topology", { collapsible: true, collapsed: !isVrUi });

  sessionCard.body.append(
    stateLabel,
    environmentLabel,
    arStartPathLabel,
    arStartDetailLabel,
    frameStats,
    trackingStats,
    trackingBackendLabel,
    selectionStatsLabel
  );
  anchorCard.body.append(spawnAnchorLabel, calibrationLabel, calibrationPanel);
  cameraCard.body.append(cameraStatsLabel, cameraPermissionLabel, xrCameraAccessLabel, cameraPiPLabel, cameraPiPCanvas);
  telemetryCard.body.append(topologyStatsLabel, telemetryStatsLabel, capabilitiesLabel);

  statusGrid.append(sessionCard.card, anchorCard.card, cameraCard.card, telemetryCard.card);

  toolbar.append(startButton, xrEntryModeToggle, stopButton, cameraTrackButton, mockToggle, stressToggle);
  wrapper.append(toolbar, filterBar, statusGrid, canvasHolder);
  root.append(wrapper, xrOverlayRoot);

  const scene = new Scene();
  scene.background = new Color("#091419");

  const desktopCanvasWidth = window.innerWidth;
  const desktopCanvasHeight = Math.max(1, Math.floor(window.innerHeight * 0.75));
  const camera = new PerspectiveCamera(
    70,
    desktopCanvasWidth / desktopCanvasHeight,
    0.01,
    100
  );
  camera.position.set(0, 1.4, 2.5);
  scene.add(camera);

  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(desktopCanvasWidth, desktopCanvasHeight);
  canvasHolder.append(renderer.domElement);

  const ambient = new AmbientLight(0xffffff, 0.5);
  const keyLight = new DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(2, 4, 3);

  const cameraPiPMesh = new Mesh(
    new PlaneGeometry(0.38, 0.214),
    new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.96
    })
  );
  cameraPiPMesh.visible = false;
  cameraPiPMesh.position.set(0.72, 1.66, -1.18);
  cameraPiPMesh.name = "camera-pip";

  const cameraFeedMesh = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      depthWrite: false
    })
  );
  cameraFeedMesh.visible = false;
  cameraFeedMesh.renderOrder = -1000;
  cameraFeedMesh.position.set(0, 0, -0.05);
  cameraFeedMesh.name = "camera-feed";
  camera.add(cameraFeedMesh);

  scene.add(ambient, keyLight, cameraPiPMesh);

  const xrRuntime = new XrRuntime(renderer);
  const isQuestBrowser = /OculusBrowser|Meta Quest|Quest/i.test(navigator.userAgent);
  const canUseHandheldScreenFallback = isVrUi && !isQuestBrowser;
  const events = createAppEventBus();
  const xrPerformance = new PerformanceMonitor();
  const desktopPerformance = new PerformanceMonitor();
  let lastPerfEmitMs = 0;
  let xrFrameCount = 0;
  const markerCalibration = new Map<number, MarkerCalibrationState>();
  let lockedSpawnAnchor: LockedSpawnAnchorState | null = null;
  let pendingXrSpawnAnchorResolve = false;
  let cameraPermissionState: CameraPermissionState = "unknown";
  let cameraPermissionStatus: PermissionStatus | null = null;
  let capabilities: XrCapabilities | null = null;
  const desktopCameraPos = new Vector3();
  const desktopCameraQuat = new Quaternion();
  const desktopCameraQuatInv = new Quaternion();
  const markerWorldPos = new Vector3();
  const markerWorldQuat = new Quaternion();
  const resolvedSpawnPos = new Vector3();
  const resolvedSpawnQuat = new Quaternion();

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

  const setArStartDiagnostic = (
    path: string,
    detail: string,
    options: { error?: boolean } = {}
  ): void => {
    arStartPathLabel.textContent = `AR start path: ${path}`;
    arStartDetailLabel.textContent = detail;
    arStartDetailLabel.style.color = options.error ? "#ffb0b0" : "#dbe5e8";
    arStartDetailLabel.style.border = options.error
      ? "1px solid rgba(186, 86, 86, 0.45)"
      : "1px solid rgba(88, 131, 144, 0.28)";
  };

  const refreshEnvironmentLabel = (): void => {
    const hasNavigatorXr = "xr" in navigator;
    const secure = window.isSecureContext ? "yes" : "no";
    const xr = hasNavigatorXr ? "yes" : "no";
    const immersiveAr = capabilities?.immersiveAr ?? "unknown";
    const immersiveVr = capabilities?.immersiveVr ?? "unknown";
    environmentLabel.textContent =
      `Context: secure=${secure} | navigator.xr=${xr} | immersiveAr=${immersiveAr} | immersiveVr=${immersiveVr}`;
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

  const setXrCameraAccessLabel = (state: XrCameraAccessState, detail = ""): void => {
    if (state === "required") {
      xrCameraAccessLabel.textContent = "XR camera-access: granted";
      xrCameraAccessLabel.style.color = "#7be2b1";
      return;
    }
    if (state === "standard") {
      xrCameraAccessLabel.textContent = "XR camera-access: not requested (standard AR passthrough)";
      xrCameraAccessLabel.style.color = "#7fd8cf";
      return;
    }
    if (state === "fallback") {
      xrCameraAccessLabel.textContent = detail
        ? `XR camera-access: unavailable, continuing without raw XR camera frames (${detail})`
        : "XR camera-access: unavailable, continuing without raw XR camera frames";
      xrCameraAccessLabel.style.color = "#ffd27b";
      return;
    }
    if (state === "probing") {
      xrCameraAccessLabel.textContent = "XR camera-access: probing...";
      xrCameraAccessLabel.style.color = "#dbe5e8";
      return;
    }
    xrCameraAccessLabel.textContent = "XR camera-access: unknown";
    xrCameraAccessLabel.style.color = "#dbe5e8";
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

  const clearLockedSpawnAnchor = (timestampMs = performance.now()): void => {
    lockedSpawnAnchor = null;
    pendingXrSpawnAnchorResolve = false;
    spawnAnchorLabel.textContent = "Spawn anchor: waiting for stable marker";
    spawnAnchorLabel.style.color = "#dbe5e8";
    refreshStartButtonState();
    events.emit("tracking/spawn-anchor", {
      markerId: null,
      position: null,
      rotation: null,
      source: "cleared",
      timestampMs
    });
  };

  const publishLockedSpawnAnchor = (
    state: LockedSpawnAnchorState,
    source: "desktop-prelock" | "xr-resolved",
    timestampMs: number
  ): void => {
    lockedSpawnAnchor = state;
    spawnAnchorLabel.textContent = `Spawn anchor: locked to ID ${state.markerId}`;
    spawnAnchorLabel.style.color = "#7be2b1";
    refreshStartButtonState();
    events.emit("tracking/spawn-anchor", {
      markerId: state.markerId,
      position: {
        x: state.worldPosition.x,
        y: state.worldPosition.y,
        z: state.worldPosition.z
      },
      rotation: {
        x: state.worldRotation.x,
        y: state.worldRotation.y,
        z: state.worldRotation.z,
        w: state.worldRotation.w
      },
      source,
      timestampMs
    });
  };

  const updateLockedSpawnFromMarker = (marker: TrackedMarker, timestampMs: number): void => {
    markerWorldPos.set(marker.pose.position.x, marker.pose.position.y, marker.pose.position.z);
    markerWorldQuat.set(
      marker.pose.rotation.x,
      marker.pose.rotation.y,
      marker.pose.rotation.z,
      marker.pose.rotation.w
    );

    camera.getWorldPosition(desktopCameraPos);
    camera.getWorldQuaternion(desktopCameraQuat);
    desktopCameraQuatInv.copy(desktopCameraQuat).invert();

    const nextState: LockedSpawnAnchorState = {
      markerId: marker.markerId,
      worldPosition: markerWorldPos.clone(),
      worldRotation: markerWorldQuat.clone(),
      relativePosition: markerWorldPos.clone().sub(desktopCameraPos).applyQuaternion(desktopCameraQuatInv),
      relativeRotation: desktopCameraQuatInv.clone().multiply(markerWorldQuat)
    };

    publishLockedSpawnAnchor(nextState, "desktop-prelock", timestampMs);
  };

  const startArSessionWithCameraAccessProbe = async (): Promise<void> => {
    const handheldReferenceSpaceOrder: XrReferenceSpaceType[] = [
      "local",
      "local-floor",
      "bounded-floor",
      "unbounded",
      "viewer"
    ];
    const baseOptionalFeatures = [
      "local-floor",
      "dom-overlay",
      "hand-tracking",
      "anchors",
      "hit-test",
      "bounded-floor",
      "unbounded"
    ];
    const applySessionStartedOverlay = (): void => {
      xrFrameCount = 0;
      xrOverlayLabel.textContent = "AR session active | XR frames 0";
    };
    setXrCameraAccessLabel("probing");

    setArStartDiagnostic(
      "trying standard immersive-ar",
      `Attempt 1: requestSession("immersive-ar") with dom-overlay root + optional features [${baseOptionalFeatures.join(", ")}].`
    );

    try {
      await xrRuntime.start({
        mode: "immersive-ar",
        domOverlayRoot: xrOverlayRoot,
        referenceSpaceOrder: handheldReferenceSpaceOrder,
        requiredFeatures: [],
        optionalFeatures: baseOptionalFeatures
      });
      applySessionStartedOverlay();
      setXrCameraAccessLabel("standard");
      setArStartDiagnostic(
        "standard immersive-ar succeeded",
        "requestSession(\"immersive-ar\") succeeded without requesting raw camera-access."
      );
      return;
    } catch (standardError) {
      const standardDetails = standardError instanceof Error ? standardError.message : String(standardError);
      setArStartDiagnostic(
        "standard immersive-ar failed",
        `Attempt 1 failed: ${standardDetails}\nAttempt 2: retry with requiredFeatures=[camera-access].`,
        { error: true }
      );

      try {
        await xrRuntime.start({
          mode: "immersive-ar",
          domOverlayRoot: xrOverlayRoot,
          referenceSpaceOrder: handheldReferenceSpaceOrder,
          requiredFeatures: ["camera-access"],
          optionalFeatures: baseOptionalFeatures
        });
        applySessionStartedOverlay();
        setXrCameraAccessLabel("required");
        setArStartDiagnostic(
          "camera-access required succeeded",
          `Attempt 1 failed: ${standardDetails}\nAttempt 2 succeeded with requiredFeatures=[camera-access].`
        );
        return;
      } catch (primaryError) {
        const primaryDetails = primaryError instanceof Error ? primaryError.message : String(primaryError);
        const compactReason = /\bcamera-access\b/i.test(primaryDetails)
          ? "camera-access rejected"
          : "probe failed";
        setArStartDiagnostic(
          "camera-access required failed",
          `Attempt 1 failed: ${standardDetails}\nAttempt 2 failed: ${primaryDetails}\nAttempt 3: retry with optionalFeatures += camera-access.`,
          { error: true }
        );

        try {
          await xrRuntime.start({
            mode: "immersive-ar",
            domOverlayRoot: xrOverlayRoot,
            referenceSpaceOrder: handheldReferenceSpaceOrder,
            requiredFeatures: [],
            optionalFeatures: [...baseOptionalFeatures, "camera-access"]
          });
          applySessionStartedOverlay();
          setXrCameraAccessLabel("fallback", compactReason);
          setArStartDiagnostic(
            "camera-access optional succeeded",
            `Attempt 1 failed: ${standardDetails}\nAttempt 2 failed: ${primaryDetails}\nAttempt 3 succeeded with optional camera-access.`
          );
          return;
        } catch (fallbackError) {
          const fallbackDetails = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          setArStartDiagnostic(
            "dom-overlay retry pending",
            `Attempt 1 failed: ${standardDetails}\nAttempt 2 failed: ${primaryDetails}\nAttempt 3 failed: ${fallbackDetails}\nAttempt 4: retry without dom-overlay.`,
            { error: true }
          );

          try {
            await xrRuntime.start({
              mode: "immersive-ar",
              referenceSpaceOrder: handheldReferenceSpaceOrder,
              requiredFeatures: [],
              optionalFeatures: [...baseOptionalFeatures, "camera-access"]
            });
            applySessionStartedOverlay();
            setXrCameraAccessLabel("fallback", "dom-overlay disabled");
            setArStartDiagnostic(
              "immersive-ar without dom-overlay succeeded",
              `Attempt 1 failed: ${standardDetails}\nAttempt 2 failed: ${primaryDetails}\nAttempt 3 failed: ${fallbackDetails}\nAttempt 4 succeeded after removing dom-overlay.`
            );
            return;
          } catch (finalError) {
            setXrCameraAccessLabel("unknown");
            const finalDetails = finalError instanceof Error ? finalError.message : String(finalError);
            setArStartDiagnostic(
              "all immersive-ar startup paths failed",
              `Attempt 1 failed: ${standardDetails}\nAttempt 2 failed: ${primaryDetails}\nAttempt 3 failed: ${fallbackDetails}\nAttempt 4 failed: ${finalDetails}`,
              { error: true }
            );
            throw new Error(
              `standard immersive-ar failed (${standardDetails}); camera-access probe failed (${primaryDetails}); fallback failed (${fallbackDetails}); final fallback failed (${finalDetails})`
            );
          }
        }
      }
    }
  };

  events.on("app/error", (payload) => {
    frameStats.textContent = `[${payload.code}] ${payload.message}`;
  });

  refreshEnvironmentLabel();
  await refreshCameraPermissionState();

  let desktopTrackingActive = true;
  const switchableDetector = new SwitchableDetector("camera");
  switchableDetector.camera.setXrGlContext(renderer.getContext());
  let xrEntryMode: XrEntryMode = "prelock";
  const applyImmersiveOverlayLayout = (): void => {
    xrOverlayRoot.style.display = "block";
  };
  const restoreImmersiveOverlayLayout = (): void => {
    xrOverlayRoot.style.display = "none";
  };
  const resizeRendererToViewport = (): void => {
    const nextWidth = window.innerWidth;
    const nextHeight = handheldScreen.isActive()
      ? Math.max(1, window.innerHeight)
      : Math.max(1, Math.floor(window.innerHeight * 0.75));
    camera.aspect = nextWidth / nextHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(nextWidth, nextHeight);
    updateDesktopCameraFeed();
  };
  const handheldScreen = new HandheldScreenController({
    camera,
    renderer,
    wrapper,
    toolbar,
    filterBar,
    statusGrid,
    canvasHolder,
    onLayoutChange: resizeRendererToViewport
  });
  const shouldUseHandheldScreenFallback = (): boolean =>
    canUseHandheldScreenFallback && capabilities?.immersiveAr !== "supported";

  const refreshStartButtonState = (): void => {
    const state = xrRuntime.getState();
    let enabled = true;
    let label = "Start AR Session";
    let hint = "Start an immersive AR session.";

    if (handheldScreen.isActive()) {
      enabled = false;
      label = "Screen View Active";
      hint = "Use Stop Session to leave the fullscreen phone view.";
    } else if (state === "requesting") {
      enabled = false;
      label = "Starting AR...";
      hint = "XR session request is in progress.";
    } else if (state === "running") {
      enabled = false;
      label = "AR Running";
      hint = "Stop the current AR session before starting another one.";
    } else if (!capabilities) {
      enabled = false;
      label = "Checking AR Support...";
      hint = "Detecting WebXR capabilities.";
    } else if (shouldUseHandheldScreenFallback()) {
      label = "Enter Screen View";
      hint = "WebXR AR is unavailable here. Use this phone as a fullscreen window into the 3D scene.";
    } else if (capabilities.immersiveAr !== "supported") {
      enabled = false;
      label = "AR Unsupported";
      hint = "This device/browser does not report immersive AR support.";
    } else if (
      switchableDetector.getMode() === "camera" &&
      xrEntryMode === "prelock" &&
      !desktopTrackingActive
    ) {
      enabled = false;
      label = "Enable Camera Tracking";
      hint = "Prelock mode needs live camera tracking before AR can start.";
    } else if (
      switchableDetector.getMode() === "camera" &&
      xrEntryMode === "prelock" &&
      !lockedSpawnAnchor
    ) {
      enabled = false;
      label = "Lock Marker to Start AR";
      hint = "Hold a stable marker in view until the spawn anchor locks.";
    } else if (switchableDetector.getMode() === "camera" && xrEntryMode === "prelock") {
      label = "Start AR (Marker Locked)";
      hint = "Marker lock acquired. Ready to enter AR.";
    }

    startButton.disabled = !enabled;
    startButton.textContent = label;
    startButton.title = hint;
    startButton.style.opacity = enabled ? "1" : "0.62";
    startButton.style.cursor = enabled ? "pointer" : "not-allowed";
    startButton.style.border = enabled ? "1px solid #1e5f73" : "1px solid #37515a";
    startButton.style.background = enabled ? "#0f3b48" : "#243840";
  };

  const applyXrEntryMode = async (mode: XrEntryMode): Promise<void> => {
    xrEntryMode = mode;
    xrEntryModeToggle.textContent =
      mode === "prelock" ? "XR Mode: Prelock Anchor" : "XR Mode: Passthrough Hack";
    xrEntryModeToggle.style.border =
      mode === "prelock" ? "1px solid #6a5a2a" : "1px solid #2a6a63";
    xrEntryModeToggle.style.background =
      mode === "prelock" ? "#3f3520" : "#17443f";

    switchableDetector.camera.setUserMediaPreference(
      mode === "prelock" ? "default" : "quest-passthrough"
    );

    if (mode === "prelock") {
      if (!lockedSpawnAnchor) {
        spawnAnchorLabel.textContent = "Spawn anchor: waiting for stable marker";
        spawnAnchorLabel.style.color = "#dbe5e8";
      }
    } else {
      clearLockedSpawnAnchor();
      spawnAnchorLabel.textContent = "Spawn anchor: live marker placement in XR";
      spawnAnchorLabel.style.color = "#7fd8cf";
    }

    if (
      desktopTrackingActive &&
      switchableDetector.getMode() === "camera" &&
      xrRuntime.getState() !== "running" &&
      (switchableDetector.camera.getStatus() !== "idle" || mode === "passthrough")
    ) {
      try {
        await switchableDetector.camera.restartUserMedia();
        cameraStatsLabel.textContent =
          `Camera: ready (${switchableDetector.camera.getOverlayData().captureBackend})`;
      } catch {
        cameraStatsLabel.textContent = "Camera: failed to restart";
      }
    }

    refreshStartButtonState();
  };

  xrEntryModeToggle.addEventListener("click", () => {
    void applyXrEntryMode(xrEntryMode === "prelock" ? "passthrough" : "prelock");
  });
  await applyXrEntryMode(isQuestBrowser ? "passthrough" : "prelock");

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

  capabilities = await xrRuntime.detectCapabilities();
  events.emit("xr/capabilities", {
    capabilities,
    timestampMs: performance.now()
  });
  capabilitiesLabel.textContent = `Capabilities\n${JSON.stringify(capabilities, null, 2)}`;
  refreshEnvironmentLabel();

  const setState = (): void => {
    const state = xrRuntime.getState();
    events.emit("xr/state", {
      state,
      timestampMs: performance.now()
    });
    stateLabel.textContent = handheldScreen.isActive() ? "Screen view: active" : toLabel(state);
    refreshStartButtonState();
    const stopEnabled = state === "running" || handheldScreen.isActive();
    stopButton.disabled = !stopEnabled;
    stopButton.style.opacity = stopEnabled ? "1" : "0.38";
    stopButton.style.cursor = stopEnabled ? "pointer" : "not-allowed";
    stopButton.style.border = stopEnabled ? "1px solid #7a2a2a" : "1px solid #4a3535";
    stopButton.style.background = stopEnabled ? "#5a1f1f" : "#2f2525";
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
  // Keep tracking active by default so desktop and XR scanning start
  // without requiring a separate "Start Camera Tracking" click.
  const defaultBackground = scene.background;
  let videoTexture: VideoTexture | null = null;
  let cameraPiPTexture: CanvasTexture | null = null;
  const xrCameraPos = new Vector3();
  const xrCameraQuat = new Quaternion();
  const pipOffset = new Vector3(0.38, 0.23, -0.78);
  const setDomCameraPiPVisible = (visible: boolean): void => {
    const display = visible ? "" : "none";
    cameraPiPLabel.style.display = display;
    cameraPiPCanvas.style.display = display;
  };

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

  const clearDesktopCameraFeed = (): void => {
    if (videoTexture) {
      videoTexture.dispose();
      videoTexture = null;
    }

    const material = cameraFeedMesh.material;
    if (material instanceof MeshBasicMaterial) {
      material.map = null;
      material.needsUpdate = true;
    }
    cameraFeedMesh.visible = false;
    scene.background = defaultBackground;
  };

  const updateDesktopCameraFeed = (): void => {
    clearDesktopCameraFeed();
  };

  const ensureCameraPiPCanvasTexture = (): void => {
    const material = cameraPiPMesh.material;
    if (!(material instanceof MeshBasicMaterial) || cameraPiPTexture) {
      return;
    }

    cameraPiPTexture = new CanvasTexture(inScenePiPCanvas);
    material.map = cameraPiPTexture;
    material.needsUpdate = true;
  };

  const isVideoTrackLive = (video: HTMLVideoElement): boolean => {
    const stream = video.srcObject;
    if (!(stream instanceof MediaStream)) return false;
    const tracks = stream.getVideoTracks();
    return tracks.length > 0 && tracks[0].readyState === "live" && !tracks[0].muted;
  };

  const updateInSceneCameraPiP = (inXrMode: boolean): void => {
    if (switchableDetector.getMode() !== "camera") {
      clearCameraPiPTexture();
      return;
    }

    const video = switchableDetector.camera.getVideo();
    const videoReady = Boolean(video && video.readyState >= 2 && isVideoTrackLive(video));
    ensureCameraPiPCanvasTexture();
    if (cameraPiPTexture) {
      cameraPiPTexture.needsUpdate = true;
    }
    cameraPiPMesh.visible = inXrMode && desktopTrackingActive && videoReady;

    if (inXrMode) {
      const xrCamera = renderer.xr.getCamera();
      xrCamera.getWorldPosition(xrCameraPos);
      xrCamera.getWorldQuaternion(xrCameraQuat);
      const worldOffset = pipOffset.clone().applyQuaternion(xrCameraQuat);
      cameraPiPMesh.position.copy(xrCameraPos).add(worldOffset);
      cameraPiPMesh.quaternion.copy(xrCameraQuat);
    } else {
      cameraPiPMesh.position.set(0.72, 1.66, -1.18);
      cameraPiPMesh.quaternion.identity();
    }
  };

  const desktopLoop = (time: number): void => {
    if (xrRuntime.getState() !== "running") {
      scene.background = defaultBackground;
      setDomCameraPiPVisible(true);
      const deltaMs = lastDesktopFrameTime === 0 ? 0 : time - lastDesktopFrameTime;
      lastDesktopFrameTime = time;
      if (deltaMs > 0) {
        desktopPerformance.recordFrame(time, deltaMs);
      }
      emitPerformance("desktop", time);
      handheldScreen.updateCamera();

      if (desktopTrackingActive) {
        events.emit("xr/frame", {
          time,
          deltaMs,
          frame: null,
          referenceSpace: null,
        });
      }
      updateDesktopCameraFeed();
      if (cameraPiPCtx) {
        drawCameraPiP(cameraPiPCtx, cameraPiPCanvas, switchableDetector, cameraPiPLabel);
      }
      updateInSceneCameraPiP(false);

      renderer.render(scene, camera);
      desktopLoopHandle = window.requestAnimationFrame(desktopLoop);
    }
  };
  let lastDesktopFrameTime = 0;
  desktopLoopHandle = window.requestAnimationFrame(desktopLoop);

  xrRuntime.subscribeFrame((tick) => {
    xrFrameCount += 1;
    if (xrFrameCount <= 10 || xrFrameCount % 30 === 0) {
      xrOverlayLabel.textContent = `AR session active | XR frames ${xrFrameCount}`;
    }
    scene.background = null;
    setDomCameraPiPVisible(false);
    if (tick.deltaMs > 0) {
      xrPerformance.recordFrame(tick.time, tick.deltaMs);
    }
    emitPerformance("xr", tick.time);
    if (pendingXrSpawnAnchorResolve && lockedSpawnAnchor) {
      const viewer = resolveViewerTransform(tick.frame, tick.referenceSpace);
      if (viewer) {
        resolvedSpawnPos.copy(lockedSpawnAnchor.relativePosition).applyQuaternion(viewer.rotation).add(viewer.position);
        resolvedSpawnQuat.copy(viewer.rotation).multiply(lockedSpawnAnchor.relativeRotation);
        publishLockedSpawnAnchor(
          {
            ...lockedSpawnAnchor,
            worldPosition: resolvedSpawnPos.clone(),
            worldRotation: resolvedSpawnQuat.clone()
          },
          "xr-resolved",
          tick.time
        );
        pendingXrSpawnAnchorResolve = false;
      }
    }
    events.emit("xr/frame", tick);
    const snapshot = xrPerformance.getSnapshot(tick.time);
    frameStats.textContent = `XR ${snapshot.fps.toFixed(1)} FPS | avg ${snapshot.avgFrameTimeMs.toFixed(2)}ms | p95 ${snapshot.p95FrameTimeMs.toFixed(2)}ms`;
    if (inScenePiPCtx) {
      drawCameraPiP(inScenePiPCtx, inScenePiPCanvas, switchableDetector, cameraPiPLabel);
    }
    updateInSceneCameraPiP(true);
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

    if (
      !desktopTrackingActive ||
      xrEntryMode !== "prelock" ||
      switchableDetector.getMode() !== "camera" ||
      xrRuntime.getState() === "running"
    ) {
      return;
    }

    let bestStableMarker: TrackedMarker | null = null;
    for (const marker of payload.markers) {
      const state = markerCalibration.get(marker.markerId);
      if (!state) {
        continue;
      }
      const lockMs = now - state.firstSeenMs;
      if (state.confidence < 0.72 || lockMs < 1200) {
        continue;
      }
      if (!bestStableMarker || marker.pose.confidence > bestStableMarker.pose.confidence) {
        bestStableMarker = marker;
      }
    }

    if (bestStableMarker) {
      updateLockedSpawnFromMarker(bestStableMarker, now);
    }
  });

  events.on("tracking/status", (payload) => {
    trackingBackendLabel.textContent =
      `Tracking backend: ${payload.backend} (${payload.detectorStatus})`;

    if (payload.backend === "camera-worker") {
      const overlay = switchableDetector.camera.getOverlayData();
      cameraStatsLabel.textContent = `Camera: ${payload.detectorStatus} (${overlay.captureBackend})`;
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
      if (shouldUseHandheldScreenFallback()) {
        setArStartDiagnostic(
          "screen-view fallback selected",
          "immersive-ar is unavailable on this device/browser, so the app is entering the non-WebXR fullscreen screen mode."
        );
        await handheldScreen.enter();
        setState();
        return;
      }

      await refreshCameraPermissionState();

      if (capabilities.immersiveAr !== "supported") {
        setArStartDiagnostic(
          "immersive-ar unsupported",
          "Capabilities say immersive-ar is unsupported, so requestSession(\"immersive-ar\") will not be attempted.",
          { error: true }
        );
        emitError(
          "XR_UNAVAILABLE",
          "Immersive AR is not supported here. On Android Chrome, this requires an ARCore-compatible phone with Google Play Services for AR installed.",
          true,
          { mode: "immersive-ar" }
        );
        frameStats.textContent = "Immersive AR unavailable on this device/browser.";
        setState();
        return;
      }

      if (!desktopTrackingActive) {
        desktopTrackingActive = true;
        cameraTrackButton.textContent = "Stop Camera Tracking";
        cameraTrackButton.style.border = "1px solid #7a6a2a";
        cameraTrackButton.style.background = "#5a4a1f";
        trackingStats.textContent = "Tracking markers: 0 (scanning...)";
      }

      if (switchableDetector.getMode() === "camera") {
        // Keep XR start independent from detector startup.
        // Detector startup happens from tracking frames, which matches
        // the known-good behavior in af3014 and avoids pre-start lockups.
        cameraStatsLabel.textContent =
          xrEntryMode === "prelock"
            ? "Camera: waiting for XR detector start"
            : "Camera: priming Quest passthrough workaround";
      }

      if (cameraPermissionState === "denied") {
        emitError(
          "CAMERA_PERMISSION_FAILED",
          "Camera permission denied. Marker tracking will not work with the camera detector.",
          true
        );
      }

      if (switchableDetector.getMode() === "camera" && xrEntryMode === "prelock" && !lockedSpawnAnchor) {
        setArStartDiagnostic(
          "blocked by prelock",
          "This path requires a stable marker lock before entering XR.",
          { error: true }
        );
        spawnAnchorLabel.textContent = "Spawn anchor: lock a stable marker before starting AR";
        spawnAnchorLabel.style.color = "#ffd27b";
        frameStats.textContent = "Waiting for a stable ArUco lock before starting AR.";
        setState();
        return;
      }

      if (switchableDetector.getMode() === "camera" && xrEntryMode === "passthrough") {
        try {
          await switchableDetector.camera.restartUserMedia();
          cameraStatsLabel.textContent =
            `Camera: ready (${switchableDetector.camera.getOverlayData().captureBackend})`;
        } catch {
          cameraStatsLabel.textContent = "Camera: passthrough workaround failed";
        }
      }

      pendingXrSpawnAnchorResolve = xrEntryMode === "prelock" && Boolean(lockedSpawnAnchor);
      await startArSessionWithCameraAccessProbe();
      applyImmersiveOverlayLayout();
      scene.background = null;
      clearDesktopCameraFeed();
      if (desktopLoopHandle) {
        window.cancelAnimationFrame(desktopLoopHandle);
        desktopLoopHandle = 0;
      }
      setState();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      setArStartDiagnostic("start button handler failed", details, { error: true });
      emitError("XR_SESSION_START_FAILED", `Failed to start XR session: ${details}`, true, {
        mode: "immersive-ar"
      });
      setState();
    }
  });

  stopButton.addEventListener("click", async () => {
    try {
      if (handheldScreen.isActive()) {
        await handheldScreen.exit();
        setState();
        return;
      }

      await xrRuntime.stop();
      restoreImmersiveOverlayLayout();
      scene.background = defaultBackground;
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

  xrOverlayStopButton.addEventListener("click", () => {
    if (!stopButton.disabled) {
      stopButton.click();
    }
  });

  cameraTrackButton.addEventListener("click", async () => {
    if (desktopTrackingActive) {
      desktopTrackingActive = false;
      clearLockedSpawnAnchor();
      cameraTrackButton.textContent = "Start Camera Tracking";
      cameraTrackButton.style.border = "1px solid #1e7353";
      cameraTrackButton.style.background = "#0f4830";
      trackingStats.textContent = "Tracking markers: 0";

      clearDesktopCameraFeed();
      clearCameraPiPTexture();
    } else {
      desktopTrackingActive = true;
      await refreshCameraPermissionState();
      if (switchableDetector.getMode() === "camera") {
        try {
          await switchableDetector.camera.ensureStarted();
          cameraStatsLabel.textContent =
            `Camera: ready (${switchableDetector.camera.getOverlayData().captureBackend})`;
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
    refreshStartButtonState();
  });

  mockToggle.addEventListener("click", () => {
    if (switchableDetector.getMode() === "camera") {
      clearLockedSpawnAnchor();
      switchableDetector.setMode("mock");
      mockToggle.textContent = "Mode: Mock";
      mockToggle.style.border = "1px solid #6a5a2a";
      mockToggle.style.background = "#3f3520";
      clearDesktopCameraFeed();
      clearCameraPiPTexture();
    } else {
      switchableDetector.setMode("camera");
      mockToggle.textContent = "Mode: Camera";
      mockToggle.style.border = "1px solid #4a4a6a";
      mockToggle.style.background = "#2a2a3f";
      spawnAnchorLabel.textContent = lockedSpawnAnchor
        ? `Spawn anchor: locked to ID ${lockedSpawnAnchor.markerId}`
        : "Spawn anchor: waiting for stable marker";
      spawnAnchorLabel.style.color = lockedSpawnAnchor ? "#7be2b1" : "#dbe5e8";
      // Video background will be picked up by the desktop loop
    }
    refreshStartButtonState();
  });

  let stressActive = true;
  const applyStressState = (): void => {
    if (stressActive) {
      stressToggle.textContent = "Stress: On (KML)";
      stressToggle.style.border = "1px solid #a83e8f";
      stressToggle.style.background = "#5f1f4f";
      const stressSnapshot = generateStressTopology({ kmlText });
      events.emit("topology/snapshot", {
        snapshot: stressSnapshot,
        timestampMs: performance.now(),
      });
      return;
    }

    stressToggle.textContent = "Stress: Off";
    stressToggle.style.border = "1px solid #6a3a6a";
    stressToggle.style.background = "#3f1f3f";
    topologyStatsLabel.textContent = "Topology: reloading demo data...";
  };

  stressToggle.addEventListener("click", () => {
    stressActive = !stressActive;
    applyStressState();
  });

  window.addEventListener("resize", resizeRendererToViewport);

  window.addEventListener("beforeunload", () => {
    void handheldScreen.exit();
    restoreImmersiveOverlayLayout();
    clearDesktopCameraFeed();
    clearCameraPiPTexture();
    if (cameraPermissionStatus) {
      cameraPermissionStatus.removeEventListener("change", onPermissionChange);
      cameraPermissionStatus = null;
    }
    void integrationCoordinator.disposeAll();
  });

  setState();
  applyStressState();
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
  const frameCanvas = detector.camera.getFrameCanvas();
  const overlay = detector.camera.getOverlayData();
  const hasCapturedFrame = Boolean(frameCanvas && overlay.frameCapturedAtMs > 0);

  if (!hasCapturedFrame && (!video || video.readyState < 2)) {
    label.textContent = "Camera PiP: waiting for camera frame";
    drawPiPText(ctx, canvas, "Waiting for Camera...");
    return;
  }

  const frameAgeMs = overlay.frameCapturedAtMs > 0
    ? Math.max(0, Math.round(performance.now() - overlay.frameCapturedAtMs))
    : -1;
  const trackState = overlay.trackDiagnostics.muted ? "muted" : "live";
  const sourceDetails = overlay.captureBackend === "xr-camera"
    ? "xr raw"
    : `${overlay.trackDiagnostics.readyState}/${trackState}`;

  label.textContent =
    `Camera PiP: ${overlay.width}x${overlay.height} | src ${overlay.captureBackend}\n` +
    `Track: ${sourceDetails} | evt ${overlay.trackDiagnostics.lastEvent}` +
    (frameAgeMs >= 0 ? ` | frame ${String(frameAgeMs).padStart(4, " ")}ms` : "") +
    `\nDetect: decoded ${String(overlay.debug.decodedMarkers).padStart(3, " ")}` +
    ` | quads ${String(overlay.debug.candidateQuadCount).padStart(3, " ")}` +
    ` | cand ${String(overlay.debug.candidateCount).padStart(3, " ")}` +
    `\nStable: ${String(overlay.debug.stableCount).padStart(3, " ")}` +
    ` | filtered ${String(overlay.debug.filteredCount).padStart(3, " ")}` +
    ` | pose ${String(overlay.solvedPoseCount).padStart(2, " ")}/${String(overlay.poseAttemptCount).padEnd(2, " ")}` +
    ` | pFail ${overlay.poseFailureReason}`;

  if (hasCapturedFrame && frameCanvas) {
    ctx.drawImage(frameCanvas, 0, 0, canvas.width, canvas.height);
  } else if (video) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }
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

function resolveViewerTransform(
  frame: unknown,
  referenceSpace: unknown
): { position: Vector3; rotation: Quaternion } | null {
  if (!frame || typeof frame !== "object") {
    return null;
  }

  const frameLike = frame as {
    getViewerPose?: (refSpace: unknown) => {
      transform?: {
        position?: { x: number; y: number; z: number };
        orientation?: { x: number; y: number; z: number; w: number };
      };
    } | null;
  };

  if (typeof frameLike.getViewerPose !== "function") {
    return null;
  }

  const pose = frameLike.getViewerPose(referenceSpace);
  const transform = pose?.transform;
  const position = transform?.position;
  const orientation = transform?.orientation;
  if (!position || !orientation) {
    return null;
  }

  return {
    position: new Vector3(position.x, position.y, position.z),
    rotation: new Quaternion(orientation.x, orientation.y, orientation.z, orientation.w)
  };
}
