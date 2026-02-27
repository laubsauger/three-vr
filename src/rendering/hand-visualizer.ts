/**
 * Renders detected hand joints as small spheres and bone connections.
 * Shows pinch indicator between thumb and index tips.
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from "three";

import type { HandData, HandJoint } from "../contracts/domain";

// Bone connections for visualization (pairs of joint names)
const BONE_CONNECTIONS: Array<[string, string]> = [
  ["wrist", "thumb-metacarpal"],
  ["thumb-metacarpal", "thumb-phalanx-proximal"],
  ["thumb-phalanx-proximal", "thumb-phalanx-distal"],
  ["thumb-phalanx-distal", "thumb-tip"],
  ["wrist", "index-finger-metacarpal"],
  ["index-finger-metacarpal", "index-finger-phalanx-proximal"],
  ["index-finger-phalanx-proximal", "index-finger-phalanx-intermediate"],
  ["index-finger-phalanx-intermediate", "index-finger-phalanx-distal"],
  ["index-finger-phalanx-distal", "index-finger-tip"],
  ["wrist", "middle-finger-metacarpal"],
  ["middle-finger-metacarpal", "middle-finger-phalanx-proximal"],
  ["middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate"],
  ["middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal"],
  ["middle-finger-phalanx-distal", "middle-finger-tip"],
  ["wrist", "ring-finger-metacarpal"],
  ["ring-finger-metacarpal", "ring-finger-phalanx-proximal"],
  ["ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate"],
  ["ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal"],
  ["ring-finger-phalanx-distal", "ring-finger-tip"],
  ["wrist", "pinky-finger-metacarpal"],
  ["pinky-finger-metacarpal", "pinky-finger-phalanx-proximal"],
  ["pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate"],
  ["pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal"],
  ["pinky-finger-phalanx-distal", "pinky-finger-tip"],
];

const JOINT_RADIUS = 0.005;
const TIP_RADIUS = 0.006;
const TIPS = new Set(["thumb-tip", "index-finger-tip", "middle-finger-tip", "ring-finger-tip", "pinky-finger-tip"]);

interface HandVisual {
  group: Group;
  jointMeshes: Map<string, Mesh>;
  boneLinesGroup: Group;
  pinchIndicator: Mesh;
}

export class HandVisualizer {
  private readonly root = new Group();
  private hands: Map<string, HandVisual> = new Map();
  private readonly jointGeom = new SphereGeometry(JOINT_RADIUS, 6, 4);
  private readonly tipGeom = new SphereGeometry(TIP_RADIUS, 8, 6);

  constructor() {
    this.root.name = "hand-visualizer";
  }

  getRoot(): Group {
    return this.root;
  }

  update(handsData: HandData[]): void {
    const seen = new Set<string>();

    for (const handData of handsData) {
      seen.add(handData.hand);
      let visual = this.hands.get(handData.hand);

      if (!visual) {
        visual = this.createHandVisual(handData.hand);
        this.hands.set(handData.hand, visual);
        this.root.add(visual.group);
      }

      visual.group.visible = true;
      this.updateJoints(visual, handData.joints);
      this.updateBones(visual, handData.joints);
      this.updatePinchIndicator(visual, handData);
    }

    // Hide unseen hands
    for (const [key, visual] of this.hands) {
      if (!seen.has(key)) {
        visual.group.visible = false;
      }
    }
  }

  dispose(): void {
    for (const visual of this.hands.values()) {
      this.disposeHandVisual(visual);
    }
    this.hands.clear();
    this.jointGeom.dispose();
    this.tipGeom.dispose();
  }

  private createHandVisual(handedness: string): HandVisual {
    const group = new Group();
    group.name = `hand-${handedness}`;

    const boneLinesGroup = new Group();
    boneLinesGroup.name = `hand-bones-${handedness}`;
    group.add(boneLinesGroup);

    // Pinch indicator (glowing sphere at pinch point)
    const pinchIndicator = new Mesh(
      new SphereGeometry(0.01, 12, 8),
      new MeshStandardMaterial({
        color: "#00ffcc",
        emissive: "#00ffcc",
        emissiveIntensity: 1.2,
        transparent: true,
        opacity: 0,
        metalness: 0.1,
        roughness: 0.2,
      }),
    );
    pinchIndicator.name = "pinch-indicator";
    group.add(pinchIndicator);

    return { group, jointMeshes: new Map(), boneLinesGroup, pinchIndicator };
  }

  private updateJoints(visual: HandVisual, joints: HandJoint[]): void {
    for (const joint of joints) {
      let mesh = visual.jointMeshes.get(joint.name);

      if (!mesh) {
        const isTip = TIPS.has(joint.name);
        const color = isTip ? "#00ffaa" : "#66aacc";
        mesh = new Mesh(
          isTip ? this.tipGeom : this.jointGeom,
          new MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 0.5,
            transparent: true,
            opacity: 0.8,
            metalness: 0.1,
            roughness: 0.3,
          }),
        );
        mesh.name = `joint-${joint.name}`;
        visual.group.add(mesh);
        visual.jointMeshes.set(joint.name, mesh);
      }

      mesh.position.set(joint.position.x, joint.position.y, joint.position.z);
      mesh.visible = true;
    }
  }

  private updateBones(visual: HandVisual, joints: HandJoint[]): void {
    const jointMap = new Map<string, HandJoint>();
    for (const j of joints) {
      jointMap.set(j.name, j);
    }

    // Clear old bones and rebuild (simple approach — bones change positions each frame)
    for (let i = visual.boneLinesGroup.children.length - 1; i >= 0; i--) {
      const child = visual.boneLinesGroup.children[i] as Line;
      child.geometry.dispose();
      visual.boneLinesGroup.remove(child);
    }

    for (const [a, b] of BONE_CONNECTIONS) {
      const ja = jointMap.get(a);
      const jb = jointMap.get(b);
      if (!ja || !jb) continue;

      const geom = new BufferGeometry();
      geom.setAttribute("position", new Float32BufferAttribute([
        ja.position.x, ja.position.y, ja.position.z,
        jb.position.x, jb.position.y, jb.position.z,
      ], 3));

      const line = new Line(
        geom,
        new LineBasicMaterial({
          color: "#4488aa",
          transparent: true,
          opacity: 0.5,
        }),
      );
      visual.boneLinesGroup.add(line);
    }
  }

  private updatePinchIndicator(visual: HandVisual, hand: HandData): void {
    const mat = visual.pinchIndicator.material as MeshStandardMaterial;

    if (hand.pinchStrength > 0.1) {
      visual.pinchIndicator.position.set(
        hand.pinchPoint.x,
        hand.pinchPoint.y,
        hand.pinchPoint.z,
      );
      mat.opacity = hand.pinchStrength * 0.9;
      mat.emissiveIntensity = 0.5 + hand.pinchStrength * 1.5;

      // Scale up when pinching
      const s = 1 + hand.pinchStrength * 0.5;
      visual.pinchIndicator.scale.set(s, s, s);
      visual.pinchIndicator.visible = true;
    } else {
      visual.pinchIndicator.visible = false;
    }
  }

  private disposeHandVisual(visual: HandVisual): void {
    for (const mesh of visual.jointMeshes.values()) {
      (mesh.material as MeshStandardMaterial).dispose();
      visual.group.remove(mesh);
    }
    visual.jointMeshes.clear();

    for (let i = visual.boneLinesGroup.children.length - 1; i >= 0; i--) {
      const child = visual.boneLinesGroup.children[i] as Line;
      child.geometry.dispose();
      (child.material as LineBasicMaterial).dispose();
    }

    (visual.pinchIndicator.material as MeshStandardMaterial).dispose();
    visual.pinchIndicator.geometry.dispose();

    this.root.remove(visual.group);
  }
}
