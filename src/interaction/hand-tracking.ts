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

interface PinchState {
  pinching: boolean;
}

export class HandTracker {
  private readonly pinchStates: Record<Handedness, PinchState> = {
    left: { pinching: false },
    right: { pinching: false },
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
      let thumbTip: Vector3Like | null = null;
      let indexTip: Vector3Like | null = null;

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

        if (jointName === "thumb-tip") thumbTip = pos;
        if (jointName === "index-finger-tip") indexTip = pos;
      }

      if (joints.length === 0) continue;

      // Pinch detection
      const state = this.pinchStates[handedness];
      let pinching = state.pinching;
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

      const prevPinching = state.pinching;
      state.pinching = pinching;

      results.push({
        hand: handedness,
        joints,
        pinching,
        pinchStrength,
        pinchPoint,
        _pinchChanged: pinching !== prevPinching,
        _prevPinching: prevPinching,
      } as HandData & { _pinchChanged: boolean; _prevPinching: boolean });
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

  reset(): void {
    this.pinchStates.left.pinching = false;
    this.pinchStates.right.pinching = false;
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
