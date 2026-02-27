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

interface DetectResponseMessage {
  type: "detected";
  frameId: number;
  detections: WorkerDetection[];
  bestId: number | null;
}

export interface CameraWorkerDetectorOptions {
  captureWidth?: number;
  captureHeight?: number;
  maxCaptureHz?: number;
  staleThresholdMs?: number;
}

export type CameraWorkerDetectorStatus = "idle" | "starting" | "ready" | "failed";

const DEFAULT_MARKER_SIZE_METERS = 0.12;
const ASSUMED_CAMERA_FOV_Y_RAD = (70 * Math.PI) / 180;
const MIN_ESTIMATED_DISTANCE_METERS = 0.25;
const MAX_ESTIMATED_DISTANCE_METERS = 8.0;
const DESKTOP_CAMERA_WORLD_POS = { x: 0, y: 1.4, z: 2.5 };
const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

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
  private latestAtMs = 0;
  private frameCounter = 0;
  private workerBusy = false;
  private lastCaptureAtMs = 0;
  private isStarting = false;
  private startFailed = false;

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

    return this.latestDetections.map((detection) =>
      toRawMarkerDetection(
        detection,
        now,
        this.captureWidth,
        this.captureHeight,
        _frame,
        _referenceSpace
      )
    );
  }

  getVideo(): HTMLVideoElement | null {
    return this.video;
  }

  /** Latest detections with pixel-space corners for overlay drawing. */
  getOverlayData(): { detections: WorkerDetection[]; bestId: number | null; width: number; height: number } {
    return {
      detections: this.latestDetections,
      bestId: this.latestBestId,
      width: this.captureWidth,
      height: this.captureHeight,
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
    this.latestAtMs = 0;
    this.workerBusy = false;
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

      worker.addEventListener("message", (event: MessageEvent<DetectResponseMessage>) => {
        const payload = event.data;
        if (!payload || payload.type !== "detected") {
          return;
        }
        this.latestDetections = payload.detections;
        this.latestBestId = payload.bestId;
        this.latestAtMs = performance.now();
        this.workerBusy = false;
      });

      worker.addEventListener("error", () => {
        this.startFailed = true;
        this.latestDetections = [];
        this.latestBestId = null;
        this.workerBusy = false;
      });

      worker.addEventListener("messageerror", () => {
        this.startFailed = true;
        this.latestDetections = [];
        this.latestBestId = null;
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
): RawMarkerDetection {
  const aspect = captureWidth / Math.max(1, captureHeight);
  const tanHalfFovY = Math.tan(ASSUMED_CAMERA_FOV_Y_RAD * 0.5);
  const tanHalfFovX = tanHalfFovY * aspect;
  const focalPxY = captureHeight / (2 * tanHalfFovY);
  const markerSidePx = estimateMarkerSidePixels(detection, captureWidth, captureHeight);
  const estimatedDistance = clamp(
    (DEFAULT_MARKER_SIZE_METERS * focalPxY) / Math.max(1, markerSidePx),
    MIN_ESTIMATED_DISTANCE_METERS,
    MAX_ESTIMATED_DISTANCE_METERS
  );

  const ndcX = (detection.xNorm - 0.5) * 2;
  const ndcY = (0.5 - detection.yNorm) * 2;
  const cameraRelative = {
    x: ndcX * estimatedDistance * tanHalfFovX,
    y: ndcY * estimatedDistance * tanHalfFovY,
    z: -estimatedDistance,
  };

  const viewer = resolveViewerTransform(frame, referenceSpace) ?? {
    position: DESKTOP_CAMERA_WORLD_POS,
    rotation: IDENTITY_ROTATION
  };

  const rotation = detection.corners && detection.corners.length >= 4
    ? estimateRotationFromCorners(detection.corners, captureWidth, captureHeight)
    : IDENTITY_ROTATION;
  const worldRotation = multiplyQuat(viewer.rotation, rotation);
  const worldPosition = addVec3(
    viewer.position,
    rotateVecByQuat(cameraRelative, viewer.rotation)
  );

  return {
    markerId: detection.markerId,
    pose: {
      position: worldPosition,
      rotation: worldRotation,
      confidence: detection.confidence,
      lastSeenAtMs: nowMs
    },
    sizeMeters: DEFAULT_MARKER_SIZE_METERS
  };
}

/**
 * Estimate marker orientation from the 4 detected corner positions.
 * Uses perspective distortion cues:
 *   - Roll: angle of the top edge in image space
 *   - Pitch: ratio of top/bottom edge lengths (foreshortening)
 *   - Yaw: ratio of left/right edge lengths (foreshortening)
 * Returns a quaternion (ZYX Euler convention).
 */
function estimateRotationFromCorners(
  corners: Array<{ x: number; y: number }>,
  _width: number,
  _height: number,
): { x: number; y: number; z: number; w: number } {
  const [c0, c1, c2, c3] = corners;

  // Roll: average angle of top and bottom edges
  // Image Y is down, world Y is up → negate
  const topDx = c1.x - c0.x;
  const topDy = c1.y - c0.y;
  const botDx = c2.x - c3.x;
  const botDy = c2.y - c3.y;
  const avgDx = (topDx + botDx) / 2;
  const avgDy = (topDy + botDy) / 2;
  const roll = -Math.atan2(avgDy, avgDx);

  // Edge lengths for perspective foreshortening
  const topLen = Math.hypot(c1.x - c0.x, c1.y - c0.y);
  const bottomLen = Math.hypot(c2.x - c3.x, c2.y - c3.y);
  const leftLen = Math.hypot(c3.x - c0.x, c3.y - c0.y);
  const rightLen = Math.hypot(c2.x - c1.x, c2.y - c1.y);

  const avgH = (topLen + bottomLen) / 2;
  const avgV = (leftLen + rightLen) / 2;

  // Pitch: top edge shorter than bottom → marker tilts backward
  const pitch = avgH > 1 ? Math.atan2(bottomLen - topLen, avgH) : 0;
  // Yaw: left edge shorter than right → marker turns left
  const yaw = avgV > 1 ? Math.atan2(rightLen - leftLen, avgV) : 0;

  return eulerZYXToQuaternion(pitch, yaw, roll);
}

/** Convert ZYX Euler angles (pitch=X, yaw=Y, roll=Z) to a quaternion. */
function eulerZYXToQuaternion(
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number; w: number } {
  const cx = Math.cos(x / 2);
  const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2);
  const sz = Math.sin(z / 2);

  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}

function estimateMarkerSidePixels(
  detection: WorkerDetection,
  captureWidth: number,
  captureHeight: number
): number {
  if (detection.corners && detection.corners.length >= 4) {
    const [c0, c1, c2, c3] = detection.corners;
    const top = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    const right = Math.hypot(c2.x - c1.x, c2.y - c1.y);
    const bottom = Math.hypot(c2.x - c3.x, c2.y - c3.y);
    const left = Math.hypot(c3.x - c0.x, c3.y - c0.y);
    return (top + right + bottom + left) / 4;
  }

  return detection.sizeNorm * Math.max(captureWidth, captureHeight);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
