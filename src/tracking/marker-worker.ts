/**
 * Web Worker for real ArUco marker detection using js-aruco2.
 *
 * Uses ?raw imports + Function.call() to load js-aruco2's CJS modules in
 * the worker context, since the library uses `this.AR = AR` globals that
 * don't work in strict-mode ES modules.
 */

import cvSource from "js-aruco2/src/cv.js?raw";
import arucoSource from "js-aruco2/src/aruco.js?raw";
import dictSource from "js-aruco2/src/dictionaries/aruco_4x4_1000.js?raw";

// ---- Types ----

interface DetectRequestMessage {
  type: "detect";
  frameId: number;
  width: number;
  height: number;
  pixels: ArrayBuffer;
}

interface WorkerDetection {
  markerId: number;
  xNorm: number;
  yNorm: number;
  sizeNorm: number;
  confidence: number;
  score: number;
  corners: Array<{ x: number; y: number }>;
}

interface DetectResponseMessage {
  type: "detected";
  frameId: number;
  detections: WorkerDetection[];
}

interface ArucoMarker {
  id: number;
  corners: Array<{ x: number; y: number }>;
  hammingDistance: number;
}

interface ArucoDetectorInstance {
  detect(imageData: { width: number; height: number; data: Uint8ClampedArray }): ArucoMarker[];
}

// ---- Load js-aruco2 into worker scope ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx: Record<string, any> = {};

// Evaluate CJS modules with ctx as `this` (non-strict mode via Function)
new Function(cvSource).call(ctx);
new Function(arucoSource).call(ctx);
new Function(dictSource).call(ctx);

const AR = ctx.AR;
if (!AR?.Detector) {
  throw new Error("Failed to initialize ArUco detector in worker");
}

const detector: ArucoDetectorInstance = new AR.Detector({
  dictionaryName: "ARUCO_4X4_1000",
  maxHammingDistance: 3,
});

// ---- Message handler ----

self.addEventListener("message", (event: MessageEvent<DetectRequestMessage>) => {
  const payload = event.data;
  if (!payload || payload.type !== "detect") {
    return;
  }

  const pixels = new Uint8ClampedArray(payload.pixels);
  const detections = runDetection(pixels, payload.width, payload.height);

  const response: DetectResponseMessage = {
    type: "detected",
    frameId: payload.frameId,
    detections,
  };
  self.postMessage(response);
});

// ---- Detection ----

function runDetection(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): WorkerDetection[] {
  // js-aruco2 expects RGBA ImageData-like input
  const markers = detector.detect({ width, height, data: rgba });

  return markers.map((marker) => {
    // Compute normalized center from corners
    let cx = 0;
    let cy = 0;
    for (const corner of marker.corners) {
      cx += corner.x;
      cy += corner.y;
    }
    cx /= 4;
    cy /= 4;

    // Compute marker size from corner diagonal
    const dx = marker.corners[2].x - marker.corners[0].x;
    const dy = marker.corners[2].y - marker.corners[0].y;
    const diagonal = Math.sqrt(dx * dx + dy * dy);
    const sizeNorm = (diagonal / Math.sqrt(2)) / Math.max(width, height);

    // Confidence based on Hamming distance (0 = perfect match)
    const confidence = Math.max(0.5, 1.0 - marker.hammingDistance * 0.15);

    return {
      markerId: marker.id,
      xNorm: cx / width,
      yNorm: cy / height,
      sizeNorm,
      confidence,
      score: confidence * 100 + (1 - marker.hammingDistance / 3) * 50,
      corners: marker.corners,
    };
  });
}
