/**
 * Web Worker for real ArUco marker detection using js-aruco2.
 *
 * This worker stays focused on marker decode only. It returns raw corners
 * from the known-good detection path, and pose is solved later from those
 * same corners so pose failures cannot suppress detection.
 *
 * Dictionary: ARUCO_6X6_1000 (IDs 0–249 are the standard 6x6_250 set).
 */

import cvSource from "js-aruco2/src/cv.js?raw";
import arucoSource from "js-aruco2/src/aruco.js?raw";
import dictSource from "js-aruco2/src/dictionaries/aruco_6x6_1000.js?raw";

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

interface ArucoMarker {
  id: number;
  corners: Array<{ x: number; y: number }>;
  hammingDistance: number;
}

interface ArucoDetectorInstance {
  detect(imageData: { width: number; height: number; data: Uint8ClampedArray }): ArucoMarker[];
  contours?: unknown[];
  polys?: unknown[];
  candidates?: unknown[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx: Record<string, any> = {};

new Function(cvSource).call(ctx);
new Function(arucoSource).call(ctx);
new Function(dictSource).call(ctx);

const AR = ctx.AR;
if (!AR?.Detector) {
  throw new Error("Failed to initialize ArUco detector in worker");
}

const detector: ArucoDetectorInstance = new AR.Detector({
  dictionaryName: "ARUCO_6X6_1000",
  maxHammingDistance: 2,
});

const MAX_VALID_ID = 249;
const MIN_DIAGONAL_PX = 20;
const MIN_CONFIDENCE = 0.7;
const MIN_ASPECT_RATIO = 0.3;

const idStreak = new Map<number, number>();
const STREAK_DECAY = 2;
const MIN_STREAK = 2;

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
    debug: result.debug,
  };
  self.postMessage(response);
});

function runDetection(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): { detections: WorkerDetection[]; bestId: number | null; debug: WorkerDebugInfo } {
  const markers = detector.detect({ width, height, data: rgba });
  const debug: WorkerDebugInfo = {
    decodedMarkers: markers.length,
    contourCount: Array.isArray(detector.contours) ? detector.contours.length : 0,
    polyCount: Array.isArray(detector.polys) ? detector.polys.length : 0,
    candidateQuadCount: Array.isArray(detector.candidates) ? detector.candidates.length : 0,
    validIdCount: 0,
    candidateCount: 0,
    stableCount: 0,
    filteredCount: 0,
    rejectedInvalidId: 0,
    rejectedTooSmall: 0,
    rejectedBadAspect: 0,
    rejectedLowConfidence: 0,
  };

  const candidates: WorkerDetection[] = [];
  for (const marker of markers) {
    if (marker.id < 0 || marker.id > MAX_VALID_ID) {
      debug.rejectedInvalidId++;
      continue;
    }
    debug.validIdCount++;

    let cx = 0;
    let cy = 0;
    for (const corner of marker.corners) {
      cx += corner.x;
      cy += corner.y;
    }
    cx /= 4;
    cy /= 4;

    const dx = marker.corners[2].x - marker.corners[0].x;
    const dy = marker.corners[2].y - marker.corners[0].y;
    const diagonal = Math.sqrt(dx * dx + dy * dy);
    if (diagonal < MIN_DIAGONAL_PX) {
      debug.rejectedTooSmall++;
      continue;
    }

    const side1 = dist(marker.corners[0], marker.corners[1]);
    const side2 = dist(marker.corners[1], marker.corners[2]);
    const minSide = Math.min(side1, side2);
    const maxSide = Math.max(side1, side2);
    if (maxSide > 0 && minSide / maxSide < MIN_ASPECT_RATIO) {
      debug.rejectedBadAspect++;
      continue;
    }

    const sizeNorm = (diagonal / Math.sqrt(2)) / Math.max(width, height);
    const confidence = marker.hammingDistance === 0 ? 1.0 : 0.75;
    if (confidence < MIN_CONFIDENCE) {
      debug.rejectedLowConfidence++;
      continue;
    }

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
  debug.candidateCount = candidates.length;

  const seenIds = new Set(candidates.map((candidate) => candidate.markerId));
  for (const candidate of candidates) {
    idStreak.set(candidate.markerId, (idStreak.get(candidate.markerId) ?? 0) + 1);
  }
  for (const [id, streak] of idStreak) {
    if (seenIds.has(id)) {
      continue;
    }
    const next = streak - STREAK_DECAY;
    if (next <= 0) {
      idStreak.delete(id);
    } else {
      idStreak.set(id, next);
    }
  }

  const stable = candidates.filter((candidate) => (idStreak.get(candidate.markerId) ?? 0) >= MIN_STREAK);
  debug.stableCount = stable.length;
  if (stable.length === 0) {
    return { detections: [], bestId: null, debug };
  }

  stable.sort((a, b) => b.score - a.score);
  const bestId = stable[0].markerId;
  const filtered = stable.filter((candidate) => candidate.markerId === bestId);
  debug.filteredCount = filtered.length;

  return { detections: filtered, bestId, debug };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}
