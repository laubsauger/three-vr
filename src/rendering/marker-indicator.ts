/**
 * 3D visual indicators placed on detected ArUco markers.
 * Each marker gets:
 *   - A glowing wireframe square at the marker pose
 *   - A floating ID label sprite
 *   - A small animated object (spinning icosahedron)
 */

import {
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";

import type { TrackedMarker } from "../contracts";

interface MarkerVisual {
  group: Group;
  frame: LineLoop;
  gem: Mesh;
  label: Sprite;
  labelTexture: CanvasTexture;
  lastSeenMs: number;
}

export class MarkerIndicatorManager {
  private readonly root = new Group();
  private readonly visuals = new Map<number, MarkerVisual>();
  private readonly tmpPos = new Vector3();
  private readonly tmpQuat = new Quaternion();

  /** How long to keep a marker visual after it stops being detected. */
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

      // Position at marker pose
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

      // Animate the gem
      visual.gem.rotation.y = timeMs * 0.002;
      visual.gem.rotation.x = timeMs * 0.001;
      visual.gem.position.y = 0.06 + Math.sin(timeMs * 0.003) * 0.01;

      // Confidence-based glow
      const conf = marker.pose.confidence;
      const intensity = 0.4 + conf * 0.8;
      (visual.gem.material as MeshStandardMaterial).emissiveIntensity = intensity;
      (visual.frame.material as LineBasicMaterial).opacity = 0.4 + conf * 0.6;
    }

    // Fade out or remove unseen markers
    for (const [id, visual] of this.visuals) {
      if (seen.has(id)) continue;

      const age = timeMs - visual.lastSeenMs;
      if (age > this.fadeOutMs) {
        this.disposeVisual(visual);
        this.visuals.delete(id);
      } else {
        // Fade
        const alpha = 1 - age / this.fadeOutMs;
        visual.group.visible = alpha > 0.05;
        (visual.frame.material as LineBasicMaterial).opacity = alpha * 0.6;
        (visual.gem.material as MeshStandardMaterial).opacity = alpha;
        visual.label.material.opacity = alpha;
      }
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

    // Wireframe square (marker outline)
    const halfSize = 0.04;
    const frameGeom = new BufferGeometry();
    frameGeom.setAttribute("position", new Float32BufferAttribute([
      -halfSize, 0, -halfSize,
       halfSize, 0, -halfSize,
       halfSize, 0,  halfSize,
      -halfSize, 0,  halfSize,
    ], 3));
    const frameMat = new LineBasicMaterial({
      color: "#00ff88",
      transparent: true,
      opacity: 0.8,
      linewidth: 2,
    });
    const frame = new LineLoop(frameGeom, frameMat);
    frame.name = "marker-frame";
    group.add(frame);

    // Small gem floating above the marker
    const gem = new Mesh(
      new IcosahedronGeometry(0.015, 1),
      new MeshStandardMaterial({
        color: "#00ff88",
        emissive: "#00ff88",
        emissiveIntensity: 0.8,
        metalness: 0.3,
        roughness: 0.2,
        transparent: true,
        opacity: 1,
        side: DoubleSide,
      }),
    );
    gem.name = "marker-gem";
    gem.position.y = 0.06;
    group.add(gem);

    // ID label sprite
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;

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
    label.position.y = 0.10;
    label.scale.set(0.06, 0.022, 1);
    label.name = "marker-label";
    group.add(label);

    return { group, frame, gem, label, labelTexture, lastSeenMs: 0 };
  }

  private disposeVisual(visual: MarkerVisual): void {
    visual.frame.geometry.dispose();
    (visual.frame.material as LineBasicMaterial).dispose();
    visual.gem.geometry.dispose();
    (visual.gem.material as MeshStandardMaterial).dispose();
    visual.labelTexture.dispose();
    visual.label.material.dispose();
    this.root.remove(visual.group);
  }
}
