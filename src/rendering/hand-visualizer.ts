/**
 * Renders a head-locked mini rig for hand debugging.
 * The overlay stays fixed in the user's view and draws hands relative to the head.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Camera,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";

import type { HandData, HandJoint, Handedness, Vector3Like } from "../contracts/domain";

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
const OVERLAY_OFFSET = new Vector3(0.24, -0.11, -0.42);
const WORLD_TO_WIDGET_SCALE = 0.34;
const BODY_COLOR = "#7f96a3";
const BODY_HEAD_COLOR = "#d9eef2";
const BODY_FORWARD_COLOR = "#ffaa44";
const PALM_ARROW_LENGTH = 0.032;
const HAND_COLORS: Record<Handedness, { joint: string; tip: string; line: string; pinch: string }> = {
  left: {
    joint: "#6ca8c0",
    tip: "#9ae6ff",
    line: "#4d89a1",
    pinch: "#00ffcc",
  },
  right: {
    joint: "#d0905f",
    tip: "#ffd2ab",
    line: "#c27b40",
    pinch: "#ffb347",
  },
};
const LINE_POSITIONS = new Float32Array(6);

interface HandVisual {
  handedness: Handedness;
  group: Group;
  jointMeshes: Map<string, Mesh>;
  boneLines: Map<string, Line>;
  palmArrow: Line;
  pinchIndicator: Mesh;
}

export class HandVisualizer {
  private readonly root = new Group();
  private readonly bodyGuide: Group;
  private hands: Map<string, HandVisual> = new Map();
  private readonly jointGeom = new SphereGeometry(JOINT_RADIUS, 6, 4);
  private readonly tipGeom = new SphereGeometry(TIP_RADIUS, 8, 6);
  private readonly headGeom = new SphereGeometry(0.014, 12, 10);
  private readonly latestHands: HandData[] = [];
  private readonly tmpCameraPos = new Vector3();
  private readonly tmpCameraQuat = new Quaternion();
  private readonly tmpCameraQuatInv = new Quaternion();
  private readonly tmpForward = new Vector3();
  private readonly tmpRight = new Vector3();
  private readonly tmpUp = new Vector3();
  private readonly tmpVecA = new Vector3();
  private readonly tmpVecB = new Vector3();
  private readonly tmpVecC = new Vector3();
  private readonly tmpVecD = new Vector3();

  constructor() {
    this.root.name = "hand-visualizer";
    this.root.renderOrder = 1000;
    this.bodyGuide = this.createBodyGuide();
    this.root.add(this.bodyGuide);
  }

  getRoot(): Group {
    return this.root;
  }

  setHands(handsData: HandData[]): void {
    this.latestHands.length = 0;
    this.latestHands.push(...handsData);
  }

  update(camera?: Camera): void {
    if (!camera) {
      return;
    }

    this.updateAnchor(camera);
    const seen = new Set<string>();

    for (const handData of this.latestHands) {
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
      this.updatePalmArrow(visual, handData.joints);
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
    this.disposeBodyGuide();
    this.jointGeom.dispose();
    this.tipGeom.dispose();
    this.headGeom.dispose();
  }

  private createHandVisual(handedness: Handedness): HandVisual {
    const group = new Group();
    group.name = `hand-${handedness}`;
    const colors = HAND_COLORS[handedness];

    // Pinch indicator (glowing sphere at pinch point)
    const pinchIndicator = new Mesh(
      new SphereGeometry(0.01, 12, 8),
      new MeshBasicMaterial({
        color: colors.pinch,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      }),
    );
    pinchIndicator.name = "pinch-indicator";
    pinchIndicator.renderOrder = 1000;
    pinchIndicator.frustumCulled = false;
    group.add(pinchIndicator);

    const palmArrow = this.createDynamicLine(colors.pinch, 0.9, `palm-arrow-${handedness}`);
    group.add(palmArrow);

    return { handedness, group, jointMeshes: new Map(), boneLines: new Map(), palmArrow, pinchIndicator };
  }

  private updateJoints(visual: HandVisual, joints: HandJoint[]): void {
    const seen = new Set<string>();

    for (const joint of joints) {
      seen.add(joint.name);
      let mesh = visual.jointMeshes.get(joint.name);

      if (!mesh) {
        const isTip = TIPS.has(joint.name);
        const colors = HAND_COLORS[visual.handedness];
        const color = isTip ? colors.tip : colors.joint;
        mesh = new Mesh(
          isTip ? this.tipGeom : this.jointGeom,
          new MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.8,
            depthTest: false,
            depthWrite: false,
          }),
        );
        mesh.name = `joint-${joint.name}`;
        mesh.renderOrder = 1000;
        mesh.frustumCulled = false;
        visual.group.add(mesh);
        visual.jointMeshes.set(joint.name, mesh);
      }

      this.toWidgetPosition(joint.position, this.tmpVecA);
      mesh.position.copy(this.tmpVecA);
      mesh.visible = true;
    }

    for (const [name, mesh] of visual.jointMeshes) {
      if (!seen.has(name)) {
        mesh.visible = false;
      }
    }
  }

  private updateBones(visual: HandVisual, joints: HandJoint[]): void {
    const jointMap = new Map<string, HandJoint>();
    for (const j of joints) {
      jointMap.set(j.name, j);
    }

    for (const bone of visual.boneLines.values()) {
      bone.visible = false;
    }

    for (const [a, b] of BONE_CONNECTIONS) {
      const ja = jointMap.get(a);
      const jb = jointMap.get(b);
      if (!ja || !jb) continue;

      const key = `${a}:${b}`;
      let line = visual.boneLines.get(key);
      if (!line) {
        const colors = HAND_COLORS[visual.handedness];
        const geom = new BufferGeometry();
        geom.setAttribute("position", new Float32BufferAttribute(LINE_POSITIONS.slice(), 3));
        line = new Line(
          geom,
          new LineBasicMaterial({
            color: colors.line,
            transparent: true,
            opacity: 0.68,
            depthTest: false,
            depthWrite: false,
          }),
        );
        line.renderOrder = 1000;
        line.frustumCulled = false;
        visual.group.add(line);
        visual.boneLines.set(key, line);
      }

      this.toWidgetPosition(ja.position, this.tmpVecA);
      this.toWidgetPosition(jb.position, this.tmpVecB);

      const positionAttr = line.geometry.getAttribute("position") as BufferAttribute;
      positionAttr.setXYZ(0, this.tmpVecA.x, this.tmpVecA.y, this.tmpVecA.z);
      positionAttr.setXYZ(1, this.tmpVecB.x, this.tmpVecB.y, this.tmpVecB.z);
      positionAttr.needsUpdate = true;
      line.visible = true;
    }
  }

  private updatePinchIndicator(visual: HandVisual, hand: HandData): void {
    const mat = visual.pinchIndicator.material as MeshBasicMaterial;

    if (hand.pinchStrength > 0.1) {
      this.toWidgetPosition(hand.pinchPoint, this.tmpVecA);
      visual.pinchIndicator.position.copy(this.tmpVecA);
      mat.opacity = hand.pinchStrength * 0.9;

      // Scale up when pinching
      const s = 1 + hand.pinchStrength * 0.5;
      visual.pinchIndicator.scale.set(s, s, s);
      visual.pinchIndicator.visible = true;
    } else {
      visual.pinchIndicator.visible = false;
    }
  }

  private updatePalmArrow(visual: HandVisual, joints: HandJoint[]): void {
    const wrist = joints.find((joint) => joint.name === "wrist");
    const indexBase = joints.find((joint) => joint.name === "index-finger-metacarpal");
    const pinkyBase = joints.find((joint) => joint.name === "pinky-finger-metacarpal");

    if (!wrist || !indexBase || !pinkyBase) {
      visual.palmArrow.visible = false;
      return;
    }

    this.toWidgetPosition(wrist.position, this.tmpVecA);
    this.toWidgetPosition(indexBase.position, this.tmpVecB);
    this.toWidgetPosition(pinkyBase.position, this.tmpVecC);

    const palmCenter = this.tmpVecD
      .copy(this.tmpVecA)
      .add(this.tmpVecB)
      .add(this.tmpVecC)
      .multiplyScalar(1 / 3);

    const palmNormal = this.tmpVecB
      .sub(this.tmpVecA)
      .cross(this.tmpVecC.clone().sub(this.tmpVecA))
      .normalize();

    if (!Number.isFinite(palmNormal.x) || palmNormal.lengthSq() < 1e-6) {
      visual.palmArrow.visible = false;
      return;
    }

    if (visual.handedness === "right") {
      palmNormal.multiplyScalar(-1);
    }

    this.updateDynamicLine(
      visual.palmArrow,
      palmCenter,
      this.tmpVecA.copy(palmCenter).addScaledVector(palmNormal, PALM_ARROW_LENGTH),
    );
    visual.palmArrow.visible = true;
  }

  private disposeHandVisual(visual: HandVisual): void {
    for (const mesh of visual.jointMeshes.values()) {
      (mesh.material as MeshBasicMaterial).dispose();
      visual.group.remove(mesh);
    }
    visual.jointMeshes.clear();

    for (const line of visual.boneLines.values()) {
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
      visual.group.remove(line);
    }
    visual.boneLines.clear();

    visual.palmArrow.geometry.dispose();
    (visual.palmArrow.material as LineBasicMaterial).dispose();
    visual.group.remove(visual.palmArrow);

    (visual.pinchIndicator.material as MeshBasicMaterial).dispose();
    visual.pinchIndicator.geometry.dispose();

    this.root.remove(visual.group);
  }

  private updateAnchor(camera: Camera): void {
    camera.getWorldPosition(this.tmpCameraPos);
    camera.getWorldQuaternion(this.tmpCameraQuat);
    this.tmpCameraQuatInv.copy(this.tmpCameraQuat).invert();

    this.tmpForward.set(0, 0, -1).applyQuaternion(this.tmpCameraQuat);
    this.tmpRight.set(1, 0, 0).applyQuaternion(this.tmpCameraQuat);
    this.tmpUp.set(0, 1, 0).applyQuaternion(this.tmpCameraQuat);

    this.root.position.copy(this.tmpCameraPos)
      .addScaledVector(this.tmpForward, -OVERLAY_OFFSET.z)
      .addScaledVector(this.tmpRight, OVERLAY_OFFSET.x)
      .addScaledVector(this.tmpUp, OVERLAY_OFFSET.y);

    this.root.quaternion.copy(this.tmpCameraQuat);
  }

  private toWidgetPosition(world: Vector3Like, target: Vector3): Vector3 {
    return target
      .set(world.x, world.y, world.z)
      .sub(this.tmpCameraPos)
      .applyQuaternion(this.tmpCameraQuatInv)
      .multiplyScalar(WORLD_TO_WIDGET_SCALE);
  }

  private createBodyGuide(): Group {
    const guide = new Group();
    guide.name = "hand-debug-body-guide";

    const head = new Mesh(
      this.headGeom,
      new MeshBasicMaterial({
        color: BODY_HEAD_COLOR,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      }),
    );
    head.renderOrder = 1000;
    head.frustumCulled = false;
    guide.add(head);

    guide.add(this.createStaticLine(
      [0, 0, 0, 0, 0, -0.05],
      BODY_FORWARD_COLOR,
      0.9,
      "hand-debug-forward",
    ));
    guide.add(this.createStaticLine(
      [-0.05, -0.045, 0, 0.05, -0.045, 0],
      BODY_COLOR,
      0.65,
      "hand-debug-shoulders",
    ));
    guide.add(this.createStaticLine(
      [0, -0.01, 0, 0, -0.11, 0],
      BODY_COLOR,
      0.5,
      "hand-debug-spine",
    ));
    guide.add(this.createStaticLine(
      [-0.03, -0.11, 0, 0.03, -0.11, 0],
      BODY_COLOR,
      0.45,
      "hand-debug-hips",
    ));
    guide.add(this.createSideFrame(-0.12, HAND_COLORS.left.line, "L"));
    guide.add(this.createSideFrame(0.12, HAND_COLORS.right.line, "R"));

    return guide;
  }

  private createStaticLine(
    coords: [number, number, number, number, number, number],
    color: string,
    opacity: number,
    name: string,
  ): Line {
    const geom = new BufferGeometry();
    geom.setAttribute("position", new Float32BufferAttribute(coords, 3));
    const line = new Line(
      geom,
      new LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
      }),
    );
    line.name = name;
    line.renderOrder = 1000;
    line.frustumCulled = false;
    return line;
  }

  private createDynamicLine(color: string, opacity: number, name: string): Line {
    const line = this.createStaticLine([0, 0, 0, 0, 0, 0], color, opacity, name);
    line.visible = false;
    return line;
  }

  private updateDynamicLine(line: Line, start: Vector3, end: Vector3): void {
    const positionAttr = line.geometry.getAttribute("position") as BufferAttribute;
    positionAttr.setXYZ(0, start.x, start.y, start.z);
    positionAttr.setXYZ(1, end.x, end.y, end.z);
    positionAttr.needsUpdate = true;
  }

  private createSideFrame(x: number, color: string, label: string): Group {
    const frame = new Group();
    frame.name = `hand-debug-frame-${label.toLowerCase()}`;
    frame.add(this.createStaticLine([x, 0.05, 0, x, -0.14, 0], color, 0.3, `${frame.name}-rail`));
    frame.add(this.createStaticLine([x, 0.05, 0, x + (x < 0 ? 0.022 : -0.022), 0.05, 0], color, 0.45, `${frame.name}-cap-top`));
    frame.add(this.createStaticLine([x, -0.14, 0, x + (x < 0 ? 0.022 : -0.022), -0.14, 0], color, 0.45, `${frame.name}-cap-bottom`));
    frame.add(this.createTextBadge(label, color, x + (x < 0 ? 0.018 : -0.018), 0.072));
    return frame;
  }

  private createTextBadge(text: string, color: string, x: number, y: number): Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D canvas context unavailable for hand debug badge.");
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(6, 12, 16, 0.76)";
    ctx.beginPath();
    ctx.roundRect(8, 8, 48, 48, 12);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(8, 8, 48, 48, 12);
    ctx.stroke();
    ctx.font = "bold 32px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 32, 34);

    const texture = new CanvasTexture(canvas);
    const sprite = new Sprite(new SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }));
    sprite.position.set(x, y, 0);
    sprite.scale.set(0.028, 0.028, 1);
    sprite.renderOrder = 1000;
    sprite.frustumCulled = false;
    sprite.name = `hand-debug-badge-${text.toLowerCase()}`;
    return sprite;
  }

  private disposeBodyGuide(): void {
    for (const child of this.bodyGuide.children) {
      if (child instanceof Mesh) {
        (child.material as MeshBasicMaterial).dispose();
      } else if (child instanceof Line) {
        child.geometry.dispose();
        (child.material as LineBasicMaterial).dispose();
      } else if (child instanceof Group) {
        for (const frameChild of child.children) {
          if (frameChild instanceof Line) {
            frameChild.geometry.dispose();
            (frameChild.material as LineBasicMaterial).dispose();
          } else if (frameChild instanceof Sprite) {
            const material = frameChild.material as SpriteMaterial;
            material.map?.dispose();
            material.dispose();
          }
        }
      }
    }
    this.root.remove(this.bodyGuide);
  }
}
