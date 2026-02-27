import svdSource from "js-aruco2/src/svd.js?raw";
import positSource from "js-aruco2/src/posit2.js?raw";

import type { MarkerDetector, RawMarkerDetection } from "./types";

interface WorkerDetection {
  markerId: number;
  xNorm: number;
  yNorm: number;
  sizeNorm: number;
  confidence: number;
  score: number;
  corners?: Array<{ x: number; y: number }>;
}

interface SolvedPose {
  rotation: number[][];
  translationMm: [number, number, number];
  error: number;
}

interface WorkerDebugInfo {
  decodedMarkers: number;
  contourCount: number;
  polyCount: number;
  candidateQuadCount: number;
  validIdCount: number;
  candidateCount: number;
  stableCount: number;
  filteredCount: number;
  rejectedInvalidId: number;
  rejectedTooSmall: number;
  rejectedBadAspect: number;
  rejectedLowConfidence: number;
}

interface DetectResponseMessage {
  type: "detected";
  frameId: number;
  detections: WorkerDetection[];
  bestId: number | null;
  debug: WorkerDebugInfo;
}

export interface CameraWorkerDetectorOptions {
  captureWidth?: number;
  captureHeight?: number;
  maxCaptureHz?: number;
  staleThresholdMs?: number;
}

export type CameraWorkerDetectorStatus = "idle" | "starting" | "ready" | "failed";

const DEFAULT_MARKER_SIZE_METERS = 0.12;
const MARKER_MODEL_SIZE_MM = 120;
const DESKTOP_CAMERA_WORLD_POS = { x: 0, y: 1.4, z: 2.5 };
const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const positCtx: Record<string, any> = {};
new Function(svdSource).call(positCtx);
new Function(positSource).call(positCtx);
const POS = positCtx.POS as { Posit?: new (modelSize: number, focalLength: number) => {
  pose: (points: Array<{ x: number; y: number }>) => unknown;
} } | undefined;
if (!POS?.Posit) {
  throw new Error("Failed to initialize POSIT solver");
}
const PositCtor = POS.Posit;

let positSolver: { pose: (points: Array<{ x: number; y: number }>) => unknown } | null = null;
let positFocalLengthPx = 0;

/**
 * Camera-backed detector scaffold.
 * Uses a worker to extract fiducial candidates from environment camera frames.
 * This is a no-network placeholder path until a dedicated ArUco decoder is added.
 */
export class CameraWorkerMarkerDetector implements MarkerDetector {
  private readonly captureWidth: number;
  private readonly captureHeight: number;
  private readonly minCaptureDeltaMs: number;
  private readonly staleThresholdMs: number;

  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context2d: CanvasRenderingContext2D | null = null;
  private latestDetections: WorkerDetection[] = [];
  private latestBestId: number | null = null;
  private latestDebug: WorkerDebugInfo = createEmptyDebugInfo();
  private latestSolvedPoseCount = 0;
  private latestPoseAttemptCount = 0;
  private latestPoseFailureReason = "none";
  private lastDebugSignature = "";
  private lastDebugLogAtMs = 0;
  private latestAtMs = 0;
  private frameCounter = 0;
  private workerBusy = false;
  private lastCaptureAtMs = 0;
  private isStarting = false;
  private startFailed = false;
  private didLogFirstCapture = false;

  constructor(options: CameraWorkerDetectorOptions = {}) {
    this.captureWidth = options.captureWidth ?? 480;
    this.captureHeight = options.captureHeight ?? 360;
    this.minCaptureDeltaMs = 1000 / (options.maxCaptureHz ?? 8);
    this.staleThresholdMs = options.staleThresholdMs ?? 550;
  }

  detect(_frame: unknown, _referenceSpace: unknown): RawMarkerDetection[] {
    const now = performance.now();

    if (!this.worker && !this.isStarting && !this.startFailed) {
      void this.start();
    }

    if (this.worker && this.video && this.context2d && !this.workerBusy) {
      if (now - this.lastCaptureAtMs >= this.minCaptureDeltaMs && this.video.readyState >= 2) {
        this.captureAndDetect(now);
      }
    }

    if (now - this.latestAtMs > this.staleThresholdMs) {
      return [];
    }

    const results: RawMarkerDetection[] = [];
    let firstPoseFailureReason = "none";
    for (const detection of this.latestDetections) {
      const solved = toRawMarkerDetection(
        detection,
        now,
        this.captureWidth,
        this.captureHeight,
        _frame,
        _referenceSpace
      );
      if (solved.detection) {
        results.push(solved.detection);
      } else if (firstPoseFailureReason === "none") {
        firstPoseFailureReason = solved.failureReason;
      }
    }
    this.latestPoseAttemptCount = this.latestDetections.length;
    this.latestSolvedPoseCount = results.length;
    this.latestPoseFailureReason = firstPoseFailureReason;
    return results;
  }

  getVideo(): HTMLVideoElement | null {
    return this.video;
  }

  /** Latest detections with pixel-space corners for overlay drawing. */
  getOverlayData(): {
    detections: WorkerDetection[];
    bestId: number | null;
    width: number;
    height: number;
    debug: WorkerDebugInfo;
    solvedPoseCount: number;
    poseAttemptCount: number;
    poseFailureReason: string;
  } {
    return {
      detections: this.latestDetections,
      bestId: this.latestBestId,
      width: this.captureWidth,
      height: this.captureHeight,
      debug: this.latestDebug,
      solvedPoseCount: this.latestSolvedPoseCount,
      poseAttemptCount: this.latestPoseAttemptCount,
      poseFailureReason: this.latestPoseFailureReason,
    };
  }

  /**
   * Pre-initialize the camera stream and worker. Call this BEFORE
   * entering an XR session so the camera is already acquired and
   * won't be blocked by the XR runtime's exclusive camera access.
   */
  async ensureStarted(): Promise<void> {
    if (this.worker || this.isStarting) return;
    if (this.startFailed) {
      // Reset so we can retry
      this.startFailed = false;
    }
    await this.start();
  }

  getStatus(): CameraWorkerDetectorStatus {
    if (this.startFailed) {
      return "failed";
    }
    if (this.isStarting) {
      return "starting";
    }
    if (this.worker && this.stream && this.video) {
      return "ready";
    }
    return "idle";
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }

    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }

    this.canvas = null;
    this.context2d = null;
    this.latestDetections = [];
    this.latestDebug = createEmptyDebugInfo();
    this.latestSolvedPoseCount = 0;
    this.latestPoseAttemptCount = 0;
    this.latestPoseFailureReason = "none";
    this.latestAtMs = 0;
    this.workerBusy = false;
    this.lastDebugSignature = "";
    this.lastDebugLogAtMs = 0;
    this.didLogFirstCapture = false;
  }

  private async start(): Promise<void> {
    this.isStarting = true;

    try {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        this.startFailed = true;
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: this.captureWidth },
          height: { ideal: this.captureHeight }
        },
        audio: false
      });

      const video = document.createElement("video");
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      video.style.position = "fixed";
      video.style.left = "-10000px";
      video.style.width = "1px";
      video.style.height = "1px";
      video.srcObject = stream;
      document.body.append(video);

      try {
        await video.play();
      } catch {
        // Some browsers gate play(); capture will begin once video can play.
      }

      const canvas = document.createElement("canvas");
      canvas.width = this.captureWidth;
      canvas.height = this.captureHeight;
      const context2d = canvas.getContext("2d", { willReadFrequently: true });
      if (!context2d) {
        this.startFailed = true;
        for (const track of stream.getTracks()) {
          track.stop();
        }
        video.remove();
        return;
      }

      const worker = new Worker(new URL("./marker-worker.ts", import.meta.url), {
        type: "module"
      });
      console.info("[marker-worker] started", {
        captureWidth: this.captureWidth,
        captureHeight: this.captureHeight,
        maxCaptureHz: Math.round(1000 / this.minCaptureDeltaMs),
      });

      worker.addEventListener("message", (event: MessageEvent<DetectResponseMessage>) => {
        const payload = event.data;
        if (!payload || payload.type !== "detected") {
          return;
        }
        this.latestDetections = payload.detections;
        this.latestBestId = payload.bestId;
        this.latestDebug = payload.debug;
        this.latestSolvedPoseCount = 0;
        this.latestPoseAttemptCount = 0;
        this.latestPoseFailureReason = "none";
        this.latestAtMs = performance.now();
        this.workerBusy = false;
        this.maybeLogDebug(payload.debug);
      });

      worker.addEventListener("error", () => {
        console.error("[marker-worker] worker error");
        this.startFailed = true;
        this.latestDetections = [];
        this.latestBestId = null;
        this.latestDebug = createEmptyDebugInfo();
        this.latestSolvedPoseCount = 0;
        this.latestPoseAttemptCount = 0;
        this.latestPoseFailureReason = "none";
        this.workerBusy = false;
      });

      worker.addEventListener("messageerror", () => {
        console.error("[marker-worker] worker messageerror");
        this.startFailed = true;
        this.latestDetections = [];
        this.latestBestId = null;
        this.latestDebug = createEmptyDebugInfo();
        this.latestSolvedPoseCount = 0;
        this.latestPoseAttemptCount = 0;
        this.latestPoseFailureReason = "none";
        this.workerBusy = false;
      });

      this.worker = worker;
      this.stream = stream;
      this.video = video;
      this.canvas = canvas;
      this.context2d = context2d;
      this.startFailed = false;
    } catch {
      this.startFailed = true;
    } finally {
      this.isStarting = false;
    }
  }

  private captureAndDetect(nowMs: number): void {
    if (!this.worker || !this.video || !this.context2d || !this.canvas) {
      return;
    }

    this.context2d.drawImage(this.video, 0, 0, this.captureWidth, this.captureHeight);
    const imageData = this.context2d.getImageData(0, 0, this.captureWidth, this.captureHeight);
    if (!this.didLogFirstCapture) {
      this.didLogFirstCapture = true;
      console.info("[marker-worker] first frame captured", {
        captureWidth: this.captureWidth,
        captureHeight: this.captureHeight,
        videoWidth: this.video.videoWidth,
        videoHeight: this.video.videoHeight,
      });
    }

    this.workerBusy = true;
    this.lastCaptureAtMs = nowMs;
    this.frameCounter += 1;

    this.worker.postMessage(
      {
        type: "detect",
        frameId: this.frameCounter,
        width: this.captureWidth,
        height: this.captureHeight,
        pixels: imageData.data.buffer
      },
      [imageData.data.buffer]
    );
  }

  private maybeLogDebug(debug: WorkerDebugInfo): void {
    const payload = {
      decodedMarkers: debug.decodedMarkers,
      contourCount: debug.contourCount,
      polyCount: debug.polyCount,
      candidateQuadCount: debug.candidateQuadCount,
      validIdCount: debug.validIdCount,
      candidateCount: debug.candidateCount,
      stableCount: debug.stableCount,
      filteredCount: debug.filteredCount,
      rejectedInvalidId: debug.rejectedInvalidId,
      rejectedTooSmall: debug.rejectedTooSmall,
      rejectedBadAspect: debug.rejectedBadAspect,
      rejectedLowConfidence: debug.rejectedLowConfidence,
    };
    const nowMs = performance.now();
    const signature = JSON.stringify(payload);
    if (signature === this.lastDebugSignature && nowMs - this.lastDebugLogAtMs < 2000) {
      return;
    }
    this.lastDebugSignature = signature;
    this.lastDebugLogAtMs = nowMs;

    if (debug.decodedMarkers === 0) {
      console.warn("[marker-worker] no decoded markers", payload);
      return;
    }
    if (debug.filteredCount === 0) {
      console.warn("[marker-worker] decoded markers but nothing survived filtering", payload);
      return;
    }
    console.info("[marker-worker] decoded markers available", payload);
  }
}

/**
 * Mock detector that produces synthetic marker detections for testing.
 * Simulates 3 markers with slight positional jitter to exercise the
 * smoothing pipeline without requiring actual camera frames.
 */
export class MockMarkerDetector implements MarkerDetector {
  private readonly mockMarkers: Array<{
    markerId: number;
    baseX: number;
    baseY: number;
    baseZ: number;
    sizeMeters: number;
  }> = [
    { markerId: 101, baseX: 0, baseY: 1.3, baseZ: -1.5, sizeMeters: 0.15 },
    { markerId: 102, baseX: 1.2, baseY: 1.3, baseZ: -1.8, sizeMeters: 0.15 },
    { markerId: 103, baseX: -0.8, baseY: 1.5, baseZ: -1.2, sizeMeters: 0.1 }
  ];

  detect(_frame: unknown, _referenceSpace: unknown): RawMarkerDetection[] {
    return this.mockMarkers
      .filter(() => Math.random() < 0.9)
      .map((marker) => {
        const jitter = () => (Math.random() - 0.5) * 0.008;

        return {
          markerId: marker.markerId,
          pose: {
            position: {
              x: marker.baseX + jitter(),
              y: marker.baseY + jitter(),
              z: marker.baseZ + jitter()
            },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            confidence: 0.72 + Math.random() * 0.26,
            lastSeenAtMs: performance.now()
          },
          sizeMeters: marker.sizeMeters
        };
      });
  }

  dispose(): void {
    // Nothing to clean up for mock.
  }
}

export type SwitchableMode = "camera" | "mock";

/**
 * Wraps a real camera detector and a mock detector, delegating to
 * whichever is currently active. Allows live toggling at runtime.
 */
export class SwitchableDetector implements MarkerDetector {
  private mode: SwitchableMode;
  readonly camera: CameraWorkerMarkerDetector;
  readonly mock: MockMarkerDetector;

  constructor(initialMode: SwitchableMode = "camera") {
    this.mode = initialMode;
    this.camera = new CameraWorkerMarkerDetector();
    this.mock = new MockMarkerDetector();
  }

  getMode(): SwitchableMode {
    return this.mode;
  }

  setMode(mode: SwitchableMode): void {
    this.mode = mode;
  }

  detect(frame: unknown, referenceSpace: unknown): RawMarkerDetection[] {
    if (this.mode === "mock") {
      return this.mock.detect(frame, referenceSpace);
    }
    return this.camera.detect(frame, referenceSpace);
  }

  dispose(): void {
    this.camera.dispose();
    this.mock.dispose();
  }
}

function toRawMarkerDetection(
  detection: WorkerDetection,
  nowMs: number,
  captureWidth: number,
  captureHeight: number,
  frame: unknown,
  referenceSpace: unknown,
): { detection: RawMarkerDetection | null; failureReason: string } {
  const poseResult = solvePoseFromCorners(detection, captureWidth, captureHeight);
  if (!poseResult.pose) {
    return {
      detection: null,
      failureReason: poseResult.failureReason
    };
  }

  const viewer = resolveViewerTransform(frame, referenceSpace) ?? {
    position: DESKTOP_CAMERA_WORLD_POS,
    rotation: IDENTITY_ROTATION
  };

  const poseEstimate = resolveCameraPoseEstimate(poseResult.pose);
  const cameraRelative = poseEstimate.position;
  const rotation = poseEstimate.rotation;
  const worldRotation = multiplyQuat(viewer.rotation, rotation);
  const worldPosition = addVec3(
    viewer.position,
    rotateVecByQuat(cameraRelative, viewer.rotation)
  );

  return {
    detection: {
      markerId: detection.markerId,
      pose: {
        position: worldPosition,
        rotation: worldRotation,
        confidence: detection.confidence,
        lastSeenAtMs: nowMs
      },
      sizeMeters: DEFAULT_MARKER_SIZE_METERS
    },
    failureReason: "none"
  };
}

function resolveCameraPoseEstimate(
  pose: SolvedPose
): {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
} {
  return {
    position: {
      x: pose.translationMm[0] / 1000,
      y: pose.translationMm[1] / 1000,
      z: -pose.translationMm[2] / 1000
    },
    rotation: quaternionFromPositMatrix(pose.rotation)
  };
}

function createEmptyDebugInfo(): WorkerDebugInfo {
  return {
    decodedMarkers: 0,
    contourCount: 0,
    polyCount: 0,
    candidateQuadCount: 0,
    validIdCount: 0,
    candidateCount: 0,
    stableCount: 0,
    filteredCount: 0,
    rejectedInvalidId: 0,
    rejectedTooSmall: 0,
    rejectedBadAspect: 0,
    rejectedLowConfidence: 0,
  };
}

function solvePoseFromCorners(
  detection: WorkerDetection,
  captureWidth: number,
  captureHeight: number
): { pose: SolvedPose | null; failureReason: string } {
  if (!detection.corners || detection.corners.length < 4) {
    return { pose: null, failureReason: "no-corners" };
  }

  const focalLengthPx = captureWidth;
  if (!positSolver || Math.abs(positFocalLengthPx - focalLengthPx) > 0.001) {
    positSolver = new PositCtor(MARKER_MODEL_SIZE_MM, focalLengthPx);
    positFocalLengthPx = focalLengthPx;
  }

  const centeredCorners = detection.corners.map((corner) => ({
    x: corner.x - captureWidth * 0.5,
    y: captureHeight * 0.5 - corner.y
  }));

  try {
    const pose = positSolver.pose(centeredCorners) as {
      bestError?: number;
      bestRotation?: number[][];
      bestTranslation?: number[];
      alternativeError?: number;
      alternativeRotation?: number[][];
      alternativeTranslation?: number[];
    };

    const candidates = [
      toSolvedPoseCandidate(pose?.bestError, pose?.bestRotation, pose?.bestTranslation),
      toSolvedPoseCandidate(pose?.alternativeError, pose?.alternativeRotation, pose?.alternativeTranslation),
    ].filter((candidate): candidate is SolvedPose => Boolean(candidate));

    if (candidates.length === 0) {
      return { pose: null, failureReason: "no-valid-candidate" };
    }

    candidates.sort((a, b) => a.error - b.error);
    return { pose: candidates[0], failureReason: "none" };
  } catch {
    return { pose: null, failureReason: "exception" };
  }
}

function toSolvedPoseCandidate(
  error: number | undefined,
  rotation: number[][] | undefined,
  translation: number[] | undefined
): SolvedPose | null {
  if (
    typeof error !== "number" ||
    !Array.isArray(rotation) ||
    rotation.length !== 3 ||
    !Array.isArray(translation) ||
    translation.length !== 3
  ) {
    return null;
  }

  const translationMm = translation as [number, number, number];
  if (
    !Number.isFinite(translationMm[0]) ||
    !Number.isFinite(translationMm[1]) ||
    !Number.isFinite(translationMm[2]) ||
    translationMm[2] <= 1
  ) {
    return null;
  }

  return {
    rotation,
    translationMm,
    error
  };
}

function quaternionFromPositMatrix(matrix: number[][]): { x: number; y: number; z: number; w: number } {
  if (
    matrix.length !== 3 ||
    matrix.some((row) => !Array.isArray(row) || row.length !== 3)
  ) {
    return IDENTITY_ROTATION;
  }

  // POSIT solves in a +Z-forward camera space. Three.js camera space is +Z-backward,
  // and our marker frame is authored for Three, so conjugate by Z flip on both sides.
  const m00 = matrix[0][0];
  const m01 = matrix[0][1];
  const m02 = -matrix[0][2];
  const m10 = matrix[1][0];
  const m11 = matrix[1][1];
  const m12 = -matrix[1][2];
  const m20 = -matrix[2][0];
  const m21 = -matrix[2][1];
  const m22 = matrix[2][2];

  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return normalizeQuaternion({
      w: 0.25 * s,
      x: (m21 - m12) / s,
      y: (m02 - m20) / s,
      z: (m10 - m01) / s
    });
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return normalizeQuaternion({
      w: (m21 - m12) / s,
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s
    });
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return normalizeQuaternion({
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s
    });
  }

  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return normalizeQuaternion({
    w: (m10 - m01) / s,
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: 0.25 * s
  });
}

function normalizeQuaternion(q: { x: number; y: number; z: number; w: number }): {
  x: number; y: number; z: number; w: number;
} {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (length < 1e-6) {
    return IDENTITY_ROTATION;
  }
  return {
    x: q.x / length,
    y: q.y / length,
    z: q.z / length,
    w: q.w / length
  };
}

function addVec3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): { x: number; y: number; z: number } {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function rotateVecByQuat(
  v: { x: number; y: number; z: number },
  q: { x: number; y: number; z: number; w: number }
): { x: number; y: number; z: number } {
  const x = v.x;
  const y = v.y;
  const z = v.z;
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;

  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);

  return {
    x: x + qw * tx + (qy * tz - qz * ty),
    y: y + qw * ty + (qz * tx - qx * tz),
    z: z + qw * tz + (qx * ty - qy * tx),
  };
}

function multiplyQuat(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number }
): { x: number; y: number; z: number; w: number } {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function resolveViewerTransform(
  frame: unknown,
  referenceSpace: unknown
): {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
} | null {
  if (!frame || typeof frame !== "object") {
    return null;
  }

  const frameLike = frame as { getViewerPose?: (refSpace: unknown) => unknown };
  if (typeof frameLike.getViewerPose !== "function") {
    return null;
  }

  const viewerPose = frameLike.getViewerPose(referenceSpace);
  if (!viewerPose || typeof viewerPose !== "object") {
    return null;
  }

  const transform = (viewerPose as { transform?: unknown }).transform;
  if (!transform || typeof transform !== "object") {
    return null;
  }

  const position = (transform as { position?: unknown }).position;
  const orientation = (transform as { orientation?: unknown }).orientation;
  if (!isVec3Like(position) || !isQuatLike(orientation)) {
    return null;
  }

  return {
    position: {
      x: position.x,
      y: position.y,
      z: position.z
    },
    rotation: {
      x: orientation.x,
      y: orientation.y,
      z: orientation.z,
      w: orientation.w
    }
  };
}

function isVec3Like(value: unknown): value is { x: number; y: number; z: number } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as { x?: unknown; y?: unknown; z?: unknown };
  return typeof v.x === "number" && typeof v.y === "number" && typeof v.z === "number";
}

function isQuatLike(value: unknown): value is { x: number; y: number; z: number; w: number } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const q = value as { x?: unknown; y?: unknown; z?: unknown; w?: unknown };
  return (
    typeof q.x === "number" &&
    typeof q.y === "number" &&
    typeof q.z === "number" &&
    typeof q.w === "number"
  );
}
