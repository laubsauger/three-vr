import type {
  MarkerSmoothState,
  QuaternionLike,
  RawMarkerDetection,
  SmootherConfig,
  TrackedMarker,
  Vector3Like,
} from "./types";
import { DEFAULT_SMOOTHER_CONFIG } from "./types";

function lerpScalar(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(out: Vector3Like, a: Vector3Like, b: Vector3Like, t: number): Vector3Like {
  out.x = lerpScalar(a.x, b.x, t);
  out.y = lerpScalar(a.y, b.y, t);
  out.z = lerpScalar(a.z, b.z, t);
  return out;
}

function dot(a: QuaternionLike, b: QuaternionLike): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

function normalizeQuat(q: QuaternionLike): QuaternionLike {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (len < 1e-8) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

/**
 * Simplified slerp — falls back to nlerp for very close quaternions,
 * which is fine for small inter-frame deltas at high refresh rates.
 */
function slerpQuat(
  out: QuaternionLike,
  a: QuaternionLike,
  b: QuaternionLike,
  t: number
): QuaternionLike {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;

  let cosHalf = dot(a, b);
  // Take shortest path
  if (cosHalf < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    cosHalf = -cosHalf;
  }

  // For very close quaternions, use nlerp
  if (cosHalf > 0.9995) {
    out.x = lerpScalar(a.x, bx, t);
    out.y = lerpScalar(a.y, by, t);
    out.z = lerpScalar(a.z, bz, t);
    out.w = lerpScalar(a.w, bw, t);
    const n = normalizeQuat(out);
    out.x = n.x; out.y = n.y; out.z = n.z; out.w = n.w;
    return out;
  }

  const halfAngle = Math.acos(cosHalf);
  const sinHalf = Math.sin(halfAngle);
  const ratioA = Math.sin((1 - t) * halfAngle) / sinHalf;
  const ratioB = Math.sin(t * halfAngle) / sinHalf;

  out.x = a.x * ratioA + bx * ratioB;
  out.y = a.y * ratioA + by * ratioB;
  out.z = a.z * ratioA + bz * ratioB;
  out.w = a.w * ratioA + bw * ratioB;
  return out;
}

export class PoseSmoother {
  private readonly config: SmootherConfig;
  private readonly states = new Map<number, MarkerSmoothState>();

  constructor(config?: Partial<SmootherConfig>) {
    this.config = { ...DEFAULT_SMOOTHER_CONFIG, ...config };
  }

  /**
   * Feed raw detections from a single frame. Returns smoothed markers
   * for all currently tracked markers (including those not seen this frame
   * but not yet stale).
   */
  update(detections: RawMarkerDetection[], nowMs: number): TrackedMarker[] {
    // Update states for detected markers
    for (const detection of detections) {
      const existing = this.states.get(detection.markerId);

      if (existing) {
        // Smooth position and rotation toward the new detection
        lerpVec3(existing.position, existing.position, detection.pose.position, this.config.positionAlpha);
        slerpQuat(existing.rotation, existing.rotation, detection.pose.rotation, this.config.rotationAlpha);
        existing.confidence = lerpScalar(existing.confidence, detection.pose.confidence, 0.4);
        existing.lastSeenAtMs = nowMs;
        existing.detectionCount++;
        if (detection.sizeMeters !== undefined) {
          existing.sizeMeters = detection.sizeMeters;
        }
      } else {
        // First sighting — initialize directly (no smoothing for first frame)
        this.states.set(detection.markerId, {
          markerId: detection.markerId,
          position: { ...detection.pose.position },
          rotation: { ...detection.pose.rotation },
          confidence: detection.pose.confidence,
          lastSeenAtMs: nowMs,
          detectionCount: 1,
          sizeMeters: detection.sizeMeters,
        });
      }
    }

    // Prune stale markers and build output
    const results: TrackedMarker[] = [];

    for (const [markerId, state] of this.states) {
      const age = nowMs - state.lastSeenAtMs;

      if (age > this.config.staleThresholdMs) {
        this.states.delete(markerId);
        continue;
      }

      // Decay confidence for markers not seen this frame
      const wasSeenThisFrame = detections.some((d) => d.markerId === markerId);
      if (!wasSeenThisFrame) {
        state.confidence *= 0.92;
      }

      results.push({
        markerId: state.markerId,
        pose: {
          position: { ...state.position },
          rotation: { ...state.rotation },
          confidence: state.confidence,
          lastSeenAtMs: state.lastSeenAtMs,
        },
        sizeMeters: state.sizeMeters,
      });
    }

    return results;
  }

  /** Returns the number of currently tracked (non-stale) markers. */
  get trackedCount(): number {
    return this.states.size;
  }

  /** Clear all tracking state. */
  reset(): void {
    this.states.clear();
  }
}
