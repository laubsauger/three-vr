/**
 * Reads WebXR hand joint data each frame and detects pinch gestures.
 *
 * WebXR Hand Input API:
 *  - session.inputSources has entries with `hand` (XRHand) property
 *  - XRHand.get(jointName) → XRJointSpace
 *  - frame.getJointPose(jointSpace, referenceSpace) → XRJointPose
 */

import type { HandData, HandJoint, Handedness, Vector3Like } from "../contracts/domain";

// ---- WebXR Hand types (not in standard TS lib) ----

interface XRJointPose {
  transform: {
    position: { x: number; y: number; z: number };
    orientation: { x: number; y: number; z: number; w: number };
  };
  radius: number;
}

interface XRJointSpace {
  jointName: string;
}

interface XRHandLike {
  get(jointName: string): XRJointSpace | undefined;
  readonly size: number;
}

interface XRInputSourceLike {
  hand?: XRHandLike;
  handedness: "none" | "left" | "right";
}

interface XRSessionLike {
  inputSources: Iterable<XRInputSourceLike>;
}

interface XRFrameLike {
  getJointPose?(jointSpace: XRJointSpace, referenceSpace: unknown): XRJointPose | null;
  session: XRSessionLike;
}

// Joints we care about (subset of the 25 WebXR hand joints)
const TRACKED_JOINTS = [
  "wrist",
  "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
  "index-finger-metacarpal", "index-finger-phalanx-proximal",
  "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip",
  "middle-finger-metacarpal", "middle-finger-phalanx-proximal",
  "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip",
  "ring-finger-metacarpal", "ring-finger-phalanx-proximal",
  "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip",
  "pinky-finger-metacarpal", "pinky-finger-phalanx-proximal",
  "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip",
];

/** Distance in meters below which thumb+index tips are considered pinching. */
const PINCH_THRESHOLD = 0.032;
/** Hysteresis: pinch releases when distance exceeds this. */
const PINCH_RELEASE_THRESHOLD = 0.055;

/**
 * Point gesture: index finger extended while middle/ring/pinky curled.
 * Detected via wrist-to-tip distance ratio: index vs average of others.
 */
const POINT_RATIO_THRESHOLD = 1.55;
const POINT_RATIO_RELEASE = 1.3;

interface PinchState {
  pinching: boolean;
}

interface PointState {
  pointing: boolean;
}

export class HandTracker {
  private readonly pinchStates: Record<Handedness, PinchState> = {
    left: { pinching: false },
    right: { pinching: false },
  };

  private readonly pointStates: Record<Handedness, PointState> = {
    left: { pointing: false },
    right: { pointing: false },
  };

  /**
   * Read hand data from an XR frame. Returns null if hand tracking
   * is unavailable in this session/frame.
   */
  readHands(frame: unknown, referenceSpace: unknown): HandData[] | null {
    const xrFrame = asXRFrame(frame);
    if (!xrFrame || !xrFrame.getJointPose) return null;

    const results: HandData[] = [];

    for (const source of xrFrame.session.inputSources) {
      if (!source.hand || (source.handedness !== "left" && source.handedness !== "right")) {
        continue;
      }

      const handedness = source.handedness as Handedness;
      const joints: HandJoint[] = [];
      let wristPos: Vector3Like | null = null;
      let thumbTip: Vector3Like | null = null;
      let indexTip: Vector3Like | null = null;
      let indexDistal: Vector3Like | null = null;
      let middleTip: Vector3Like | null = null;
      let ringTip: Vector3Like | null = null;
      let pinkyTip: Vector3Like | null = null;

      for (const jointName of TRACKED_JOINTS) {
        const jointSpace = source.hand.get(jointName);
        if (!jointSpace) continue;

        const pose = xrFrame.getJointPose!(jointSpace, referenceSpace);
        if (!pose) continue;

        const pos: Vector3Like = {
          x: pose.transform.position.x,
          y: pose.transform.position.y,
          z: pose.transform.position.z,
        };

        joints.push({
          name: jointName,
          position: pos,
          radius: pose.radius,
        });

        if (jointName === "wrist") wristPos = pos;
        if (jointName === "thumb-tip") thumbTip = pos;
        if (jointName === "index-finger-tip") indexTip = pos;
        if (jointName === "index-finger-phalanx-distal") indexDistal = pos;
        if (jointName === "middle-finger-tip") middleTip = pos;
        if (jointName === "ring-finger-tip") ringTip = pos;
        if (jointName === "pinky-finger-tip") pinkyTip = pos;
      }

      if (joints.length === 0) continue;

      // Pinch detection
      const pinchState = this.pinchStates[handedness];
      let pinching = pinchState.pinching;
      let pinchStrength = 0;
      let pinchPoint: Vector3Like = { x: 0, y: 0, z: 0 };

      if (thumbTip && indexTip) {
        const dist = distance(thumbTip, indexTip);
        pinchStrength = Math.max(0, 1 - dist / PINCH_RELEASE_THRESHOLD);

        if (!pinching && dist < PINCH_THRESHOLD) {
          pinching = true;
        } else if (pinching && dist > PINCH_RELEASE_THRESHOLD) {
          pinching = false;
        }

        pinchPoint = {
          x: (thumbTip.x + indexTip.x) / 2,
          y: (thumbTip.y + indexTip.y) / 2,
          z: (thumbTip.z + indexTip.z) / 2,
        };
      }

      const prevPinching = pinchState.pinching;
      pinchState.pinching = pinching;

      // Point gesture detection: index extended, others curled
      const pointState = this.pointStates[handedness];
      let pointing = pointState.pointing;
      let pointStrength = 0;
      let pointOrigin: Vector3Like = { x: 0, y: 0, z: 0 };
      let pointDirection: Vector3Like = { x: 0, y: 0, z: -1 };

      if (wristPos && indexTip && middleTip && ringTip && pinkyTip) {
        const indexDist = distance(wristPos, indexTip);
        const middleDist = distance(wristPos, middleTip);
        const ringDist = distance(wristPos, ringTip);
        const pinkyDist = distance(wristPos, pinkyTip);
        const avgOtherDist = (middleDist + ringDist + pinkyDist) / 3;

        const ratio = avgOtherDist > 0.001 ? indexDist / avgOtherDist : 0;
        pointStrength = Math.max(0, Math.min(1, (ratio - POINT_RATIO_RELEASE) / (POINT_RATIO_THRESHOLD - POINT_RATIO_RELEASE)));

        if (!pointing && ratio > POINT_RATIO_THRESHOLD) {
          pointing = true;
        } else if (pointing && ratio < POINT_RATIO_RELEASE) {
          pointing = false;
        }

        if (indexTip) {
          pointOrigin = { x: indexTip.x, y: indexTip.y, z: indexTip.z };
        }

        if (indexDistal && indexTip) {
          const dx = indexTip.x - indexDistal.x;
          const dy = indexTip.y - indexDistal.y;
          const dz = indexTip.z - indexDistal.z;
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (len > 0.001) {
            pointDirection = { x: dx / len, y: dy / len, z: dz / len };
          }
        }
      }

      const prevPointing = pointState.pointing;
      pointState.pointing = pointing;

      results.push({
        hand: handedness,
        joints,
        pinching,
        pinchStrength,
        pinchPoint,
        pointing,
        pointStrength,
        pointOrigin,
        pointDirection,
        _pinchChanged: pinching !== prevPinching,
        _prevPinching: prevPinching,
        _pointChanged: pointing !== prevPointing,
        _prevPointing: prevPointing,
      } as HandData & { _pinchChanged: boolean; _prevPinching: boolean; _pointChanged: boolean; _prevPointing: boolean });
    }

    return results.length > 0 ? results : null;
  }

  /**
   * Check if a hand's pinch state just changed.
   * Call after readHands() on the same frame.
   */
  getPinchTransitions(hands: HandData[]): Array<{ hand: Handedness; state: "start" | "end"; position: Vector3Like }> {
    const transitions: Array<{ hand: Handedness; state: "start" | "end"; position: Vector3Like }> = [];

    for (const h of hands) {
      const ext = h as HandData & { _pinchChanged?: boolean; _prevPinching?: boolean };
      if (ext._pinchChanged) {
        transitions.push({
          hand: h.hand,
          state: h.pinching ? "start" : "end",
          position: h.pinchPoint,
        });
      }
    }

    return transitions;
  }

  /**
   * Check if a hand's point gesture just changed.
   * Call after readHands() on the same frame.
   */
  getPointTransitions(hands: HandData[]): Array<{ hand: Handedness; state: "start" | "end"; position: Vector3Like; direction: Vector3Like }> {
    const transitions: Array<{ hand: Handedness; state: "start" | "end"; position: Vector3Like; direction: Vector3Like }> = [];

    for (const h of hands) {
      const ext = h as HandData & { _pointChanged?: boolean };
      if (ext._pointChanged) {
        transitions.push({
          hand: h.hand,
          state: h.pointing ? "start" : "end",
          position: h.pointOrigin,
          direction: h.pointDirection,
        });
      }
    }

    return transitions;
  }

  reset(): void {
    this.pinchStates.left.pinching = false;
    this.pinchStates.right.pinching = false;
    this.pointStates.left.pointing = false;
    this.pointStates.right.pointing = false;
  }
}

function distance(a: Vector3Like, b: Vector3Like): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function asXRFrame(value: unknown): XRFrameLike | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!("session" in candidate)) return null;
  return value as XRFrameLike;
}
