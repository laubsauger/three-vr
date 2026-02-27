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
    this.captureWidth = options.captureWidth ?? 640;
    this.captureHeight = options.captureHeight ?? 480;
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

    return this.latestDetections.map((detection) => toRawMarkerDetection(detection, now));
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

function toRawMarkerDetection(detection: WorkerDetection, nowMs: number): RawMarkerDetection {
  const spreadX = (detection.xNorm - 0.5) * 1.8;
  const spreadY = (0.5 - detection.yNorm) * 0.9;
  const depth = -1.05 - detection.sizeNorm * 1.25;

  return {
    markerId: detection.markerId,
    pose: {
      position: {
        x: spreadX,
        y: 1.35 + spreadY,
        z: depth
      },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      confidence: detection.confidence,
      lastSeenAtMs: nowMs
    },
    sizeMeters: Math.max(0.08, detection.sizeNorm)
  };
}
