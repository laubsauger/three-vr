/**
 * 3D visual indicators placed on detected ArUco markers.
 * Each marker gets:
 *   - A base outline matching the marker's physical size
 *   - A shallow translucent prism extruded off the marker plane
 *   - Highlighted leading face + edge lines so the volume reads clearly in XR
 *   - RGB axis arrows showing the solved 6DOF pose (X=red, Y=green, Z=blue)
 *   - A floating ID label sprite
 */

import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  ConeGeometry,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";

import type { TrackedMarker } from "../contracts";

const DEFAULT_MARKER_SIZE_METERS = 0.12;
const BOX_DEPTH_RATIO = 0.28;
const MIN_BOX_DEPTH_METERS = 0.02;

interface MarkerVisual {
  group: Group;
  baseFrame: LineLoop;
  volume: Mesh<BoxGeometry, MeshStandardMaterial>;
  volumeEdges: LineSegments<EdgesGeometry, LineBasicMaterial>;
  leadFace: Mesh<PlaneGeometry, MeshBasicMaterial>;
  axesGroup: Group;
  label: Sprite;
  labelTexture: CanvasTexture;
  lastSeenMs: number;
}

export class MarkerIndicatorManager {
  private readonly root = new Group();
  private readonly visuals = new Map<number, MarkerVisual>();
  private readonly tmpPos = new Vector3();
  private readonly tmpQuat = new Quaternion();
  private readonly fadeOutMs = 800;

  constructor() {
    this.root.name = "marker-indicators";
  }

  getRoot(): Group {
    return this.root;
  }

  update(markers: TrackedMarker[], timeMs: number): void {
    const seen = new Set<number>();

    for (const marker of markers) {
      seen.add(marker.markerId);
      let visual = this.visuals.get(marker.markerId);

      if (!visual) {
        visual = this.createVisual(marker.markerId);
        this.visuals.set(marker.markerId, visual);
        this.root.add(visual.group);
      }

      this.tmpPos.set(
        marker.pose.position.x,
        marker.pose.position.y,
        marker.pose.position.z,
      );
      this.tmpQuat.set(
        marker.pose.rotation.x,
        marker.pose.rotation.y,
        marker.pose.rotation.z,
        marker.pose.rotation.w,
      );

      visual.group.position.copy(this.tmpPos);
      visual.group.quaternion.copy(this.tmpQuat);
      visual.group.visible = true;
      visual.lastSeenMs = timeMs;

      const size = marker.sizeMeters ?? DEFAULT_MARKER_SIZE_METERS;
      const depth = Math.max(MIN_BOX_DEPTH_METERS, size * BOX_DEPTH_RATIO);
      const confidence = marker.pose.confidence;

      visual.baseFrame.scale.set(size, size, 1);
      visual.volume.scale.set(size, size, depth);
      visual.volume.position.z = -depth * 0.5;
      visual.volumeEdges.scale.copy(visual.volume.scale);
      visual.volumeEdges.position.copy(visual.volume.position);

      visual.leadFace.scale.set(size * 0.9, size * 0.9, 1);
      visual.leadFace.position.z = -depth - 0.0005;

      visual.axesGroup.scale.setScalar(size * 1.1);
      visual.label.position.set(0, size * 0.62, -depth * 0.7);

      visual.volume.material.opacity = 0.16 + confidence * 0.12;
      visual.volume.material.emissiveIntensity = 0.2 + confidence * 0.35;
      visual.leadFace.material.opacity = 0.12 + confidence * 0.1;
      (visual.baseFrame.material as LineBasicMaterial).opacity = 0.55 + confidence * 0.35;
      (visual.volumeEdges.material as LineBasicMaterial).opacity = 0.6 + confidence * 0.3;
    }

    for (const [id, visual] of this.visuals) {
      if (seen.has(id)) continue;

      const age = timeMs - visual.lastSeenMs;
      if (age > this.fadeOutMs) {
        this.disposeVisual(visual);
        this.visuals.delete(id);
        continue;
      }

      const alpha = 1 - age / this.fadeOutMs;
      visual.group.visible = alpha > 0.05;
      (visual.baseFrame.material as LineBasicMaterial).opacity = alpha * 0.8;
      (visual.volumeEdges.material as LineBasicMaterial).opacity = alpha * 0.75;
      visual.volume.material.opacity = alpha * 0.2;
      visual.leadFace.material.opacity = alpha * 0.18;
      visual.label.material.opacity = alpha;
    }
  }

  dispose(): void {
    for (const visual of this.visuals.values()) {
      this.disposeVisual(visual);
    }
    this.visuals.clear();
  }

  private createVisual(markerId: number): MarkerVisual {
    const group = new Group();
    group.name = `marker-indicator-${markerId}`;

    const halfSize = 0.5;
    const frameGeom = new BufferGeometry();
    frameGeom.setAttribute("position", new Float32BufferAttribute([
      -halfSize, -halfSize, 0,
       halfSize, -halfSize, 0,
       halfSize,  halfSize, 0,
      -halfSize,  halfSize, 0,
    ], 3));
    const frameMat = new LineBasicMaterial({
      color: "#00ff88",
      transparent: true,
      opacity: 0.85,
    });
    const baseFrame = new LineLoop(frameGeom, frameMat);
    baseFrame.name = "marker-base-frame";
    group.add(baseFrame);

    const volumeGeom = new BoxGeometry(1, 1, 1);
    const volumeMat = new MeshStandardMaterial({
      color: "#21f0a0",
      emissive: "#0b6b42",
      emissiveIntensity: 0.35,
      roughness: 0.32,
      metalness: 0.08,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    const volume = new Mesh(volumeGeom, volumeMat);
    volume.name = "marker-volume";
    volume.position.z = -0.5;
    group.add(volume);

    const volumeEdges = new LineSegments(
      new EdgesGeometry(volumeGeom),
      new LineBasicMaterial({
        color: "#8cffd3",
        transparent: true,
        opacity: 0.9,
      }),
    );
    volumeEdges.name = "marker-volume-edges";
    volumeEdges.position.copy(volume.position);
    group.add(volumeEdges);

    const leadFace = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        color: "#c8ffeb",
        transparent: true,
        opacity: 0.18,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    leadFace.name = "marker-lead-face";
    leadFace.position.z = -1.0005;
    group.add(leadFace);

    const axesGroup = this.createAxesGroup();
    group.add(axesGroup);

    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to create marker label canvas");
    }

    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    ctx.beginPath();
    ctx.roundRect(4, 4, 120, 40, 8);
    ctx.fill();
    ctx.font = "bold 26px monospace";
    ctx.fillStyle = "#00ff88";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`ID ${markerId}`, 64, 24);

    const labelTexture = new CanvasTexture(canvas);
    const labelMat = new SpriteMaterial({
      map: labelTexture,
      transparent: true,
      depthTest: false,
    });
    const label = new Sprite(labelMat);
    label.position.set(0, 0.08, -0.04);
    label.scale.set(0.06, 0.022, 1);
    label.name = "marker-label";
    group.add(label);

    return {
      group,
      baseFrame,
      volume,
      volumeEdges,
      leadFace,
      axesGroup,
      label,
      labelTexture,
      lastSeenMs: 0,
    };
  }

  private createAxesGroup(): Group {
    const axes = new Group();
    axes.name = "marker-axes";

    const shaftLength = 0.85;
    const tipHeight = 0.15;
    const tipRadius = 0.04;

    axes.add(this.createAxisArrow([shaftLength, 0, 0], 0xff3333));
    const tipX = new Mesh(
      new ConeGeometry(tipRadius, tipHeight, 6),
      new MeshStandardMaterial({ color: 0xff3333, emissive: 0xff3333, emissiveIntensity: 0.5 }),
    );
    tipX.position.set(shaftLength + tipHeight / 2, 0, 0);
    tipX.rotation.z = -Math.PI / 2;
    axes.add(tipX);

    axes.add(this.createAxisArrow([0, shaftLength, 0], 0x33ff33));
    const tipY = new Mesh(
      new ConeGeometry(tipRadius, tipHeight, 6),
      new MeshStandardMaterial({ color: 0x33ff33, emissive: 0x33ff33, emissiveIntensity: 0.5 }),
    );
    tipY.position.set(0, shaftLength + tipHeight / 2, 0);
    axes.add(tipY);

    axes.add(this.createAxisArrow([0, 0, shaftLength], 0x3388ff));
    const tipZ = new Mesh(
      new ConeGeometry(tipRadius, tipHeight, 6),
      new MeshStandardMaterial({ color: 0x3388ff, emissive: 0x3388ff, emissiveIntensity: 0.5 }),
    );
    tipZ.position.set(0, 0, shaftLength + tipHeight / 2);
    tipZ.rotation.x = -Math.PI / 2;
    axes.add(tipZ);

    return axes;
  }

  private createAxisArrow(to: [number, number, number], color: number): Line {
    const geom = new BufferGeometry();
    geom.setAttribute("position", new Float32BufferAttribute([0, 0, 0, ...to], 3));
    return new Line(geom, new LineBasicMaterial({ color }));
  }

  private disposeVisual(visual: MarkerVisual): void {
    visual.baseFrame.geometry.dispose();
    (visual.baseFrame.material as LineBasicMaterial).dispose();

    visual.volume.geometry.dispose();
    visual.volume.material.dispose();

    visual.volumeEdges.geometry.dispose();
    (visual.volumeEdges.material as LineBasicMaterial).dispose();

    visual.leadFace.geometry.dispose();
    visual.leadFace.material.dispose();

    visual.axesGroup.traverse((child) => {
      if (child instanceof Line || child instanceof Mesh) {
        child.geometry.dispose();
        if (
          child.material instanceof MeshStandardMaterial ||
          child.material instanceof LineBasicMaterial
        ) {
          child.material.dispose();
        }
      }
    });

    visual.labelTexture.dispose();
    visual.label.material.dispose();
    this.root.remove(visual.group);
  }
}
