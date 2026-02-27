/**
 * Web Worker for real ArUco marker detection using js-aruco2.
 *
 * Uses ?raw imports + Function.call() to load js-aruco2's CJS modules in
 * the worker context, since the library uses `this.AR = AR` globals that
 * don't work in strict-mode ES modules.
 *
 * Dictionary: ARUCO_6X6_1000 (IDs 0–249 are the standard 6x6_250 set).
 */

import cvSource from "js-aruco2/src/cv.js?raw";
import arucoSource from "js-aruco2/src/aruco.js?raw";
import dictSource from "js-aruco2/src/dictionaries/aruco_6x6_1000.js?raw";

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
  /** Best candidate after filtering, if any. */
  bestId: number | null;
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
  dictionaryName: "ARUCO_6X6_1000",
  maxHammingDistance: 1,
});

// ---- Filtering config ----

/** Only accept IDs in the standard 6x6_250 range. */
const MAX_VALID_ID = 249;
/** Minimum marker diagonal in pixels to filter noise from tiny false positives. */
const MIN_DIAGONAL_PX = 20;
/** Minimum confidence to be considered a valid detection. */
const MIN_CONFIDENCE = 0.7;
/** Minimum size ratio of the marker quad (reject very skewed/degenerate quads). */
const MIN_ASPECT_RATIO = 0.3;

// ---- Temporal stability ----

/** Track how many consecutive frames each ID has been seen. */
const idStreak = new Map<number, number>();
/** IDs not seen this frame get their streak decremented. */
const STREAK_DECAY = 2;
/** Minimum streak to be reported. */
const MIN_STREAK = 2;

// ---- Message handler ----

self.addEventListener("message", (event: MessageEvent<DetectRequestMessage>) => {
  const payload = event.data;
  if (!payload || payload.type !== "detect") {
    return;
  }

  const pixels = new Uint8ClampedArray(payload.pixels);
  const result = runDetection(pixels, payload.width, payload.height);

  const response: DetectResponseMessage = {
    type: "detected",
    frameId: payload.frameId,
    detections: result.detections,
    bestId: result.bestId,
  };
  self.postMessage(response);
});

// ---- Detection ----

function runDetection(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): { detections: WorkerDetection[]; bestId: number | null } {
  const markers = detector.detect({ width, height, data: rgba });

  // Score and filter raw detections
  const candidates: WorkerDetection[] = [];
  for (const marker of markers) {
    // Reject out-of-range IDs
    if (marker.id < 0 || marker.id > MAX_VALID_ID) continue;

    // Compute normalized center from corners
    let cx = 0;
    let cy = 0;
    for (const corner of marker.corners) {
      cx += corner.x;
      cy += corner.y;
    }
    cx /= 4;
    cy /= 4;

    // Compute marker diagonal in pixels
    const dx = marker.corners[2].x - marker.corners[0].x;
    const dy = marker.corners[2].y - marker.corners[0].y;
    const diagonal = Math.sqrt(dx * dx + dy * dy);

    // Reject tiny detections (noise)
    if (diagonal < MIN_DIAGONAL_PX) continue;

    // Check aspect ratio of the quad to reject degenerate shapes
    const side1 = dist(marker.corners[0], marker.corners[1]);
    const side2 = dist(marker.corners[1], marker.corners[2]);
    const minSide = Math.min(side1, side2);
    const maxSide = Math.max(side1, side2);
    if (maxSide > 0 && minSide / maxSide < MIN_ASPECT_RATIO) continue;

    const sizeNorm = (diagonal / Math.sqrt(2)) / Math.max(width, height);

    // Confidence: hamming 0 = 1.0, hamming 1 = 0.75
    const confidence = marker.hammingDistance === 0 ? 1.0 : 0.75;
    if (confidence < MIN_CONFIDENCE) continue;

    // Score combines confidence, size (larger = more reliable), and centrality
    const centeredness = 1 - Math.sqrt(
      Math.pow(cx / width - 0.5, 2) + Math.pow(cy / height - 0.5, 2)
    );
    const score = confidence * 50 + sizeNorm * 30 + centeredness * 20;

    candidates.push({
      markerId: marker.id,
      xNorm: cx / width,
      yNorm: cy / height,
      sizeNorm,
      confidence,
      score,
      corners: marker.corners,
    });
  }

  // Update temporal streaks
  const seenIds = new Set(candidates.map((c) => c.markerId));
  for (const c of candidates) {
    idStreak.set(c.markerId, (idStreak.get(c.markerId) ?? 0) + 1);
  }
  for (const [id, streak] of idStreak) {
    if (!seenIds.has(id)) {
      const next = streak - STREAK_DECAY;
      if (next <= 0) {
        idStreak.delete(id);
      } else {
        idStreak.set(id, next);
      }
    }
  }

  // Filter by streak (must be seen MIN_STREAK consecutive frames)
  const stable = candidates.filter((c) => (idStreak.get(c.markerId) ?? 0) >= MIN_STREAK);

  // If multiple IDs remain, pick the best one and only report that
  // (avoids flickering between multiple false-positive IDs)
  if (stable.length === 0) {
    return { detections: [], bestId: null };
  }

  // Sort by score descending
  stable.sort((a, b) => b.score - a.score);

  // Group by ID — if the best candidate's score is significantly above the rest, only keep it
  const best = stable[0];
  const bestId = best.markerId;

  // Keep only detections matching the best ID
  const filtered = stable.filter((c) => c.markerId === bestId);

  return { detections: filtered, bestId };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}
