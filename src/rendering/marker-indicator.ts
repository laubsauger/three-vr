/**
 * 3D visual indicators placed on detected ArUco markers.
 * Each marker gets:
 *   - A wireframe square matching the marker's physical size
 *   - RGB axis arrows showing the marker's 6DOF pose (X=red, Y=green, Z=blue)
 *   - A floating ID label sprite
 *   - A small animated gem (spinning icosahedron)
 */

import {
  BufferGeometry,
  CanvasTexture,
  ConeGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  LineLoop,
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

interface MarkerVisual {
  group: Group;
  frame: LineLoop;
  fill: Mesh<PlaneGeometry, MeshBasicMaterial>;
  axesGroup: Group;
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

      // Scale frame, fill, and axes to match marker physical size
      const size = marker.sizeMeters ?? 0.08;
      visual.frame.scale.set(size, size, 1);
      visual.fill.scale.set(size, size, 1);
      visual.axesGroup.scale.setScalar(size * 1.4);

      // Animate the gem
      visual.gem.rotation.y = timeMs * 0.002;
      visual.gem.rotation.x = timeMs * 0.001;
      visual.gem.position.set(0, 0, -(0.06 + Math.sin(timeMs * 0.003) * 0.01));

      // Confidence-based glow
      const conf = marker.pose.confidence;
      const intensity = 0.4 + conf * 0.8;
      (visual.gem.material as MeshStandardMaterial).emissiveIntensity = intensity;
      (visual.frame.material as LineBasicMaterial).opacity = 0.4 + conf * 0.6;
      visual.fill.material.opacity = 0.06 + conf * 0.1;
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
        visual.fill.material.opacity = alpha * 0.12;
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

    // Wireframe square in XY plane (normal = +Z, toward camera).
    // Unit size (1×1); scaled per-frame to match sizeMeters.
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
      opacity: 0.8,
      linewidth: 2,
    });
    const frame = new LineLoop(frameGeom, frameMat);
    frame.name = "marker-frame";
    group.add(frame);

    // Semi-transparent fill behind the wireframe
    const fillGeom = new PlaneGeometry(1, 1);
    const fillMat = new MeshBasicMaterial({
      color: "#00ff88",
      transparent: true,
      opacity: 0.12,
      side: DoubleSide,
      depthWrite: false,
    });
    const fill = new Mesh(fillGeom, fillMat);
    fill.name = "marker-fill";
    group.add(fill);

    // 3D axis arrows (RGB = XYZ). Unit length; scaled per-frame.
    const axesGroup = this.createAxesGroup();
    group.add(axesGroup);

    // Small gem floating in front of the marker
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
    gem.position.z = -0.06;
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
    label.position.set(0, 0.08, -0.02);
    label.scale.set(0.06, 0.022, 1);
    label.name = "marker-label";
    group.add(label);

    return { group, frame, fill, axesGroup, gem, label, labelTexture, lastSeenMs: 0 };
  }

  /** Create RGB axis arrows: X=red, Y=green, Z=blue (pointing toward camera). */
  private createAxesGroup(): Group {
    const axes = new Group();
    axes.name = "marker-axes";

    const shaftLength = 0.85;
    const tipHeight = 0.15;
    const tipRadius = 0.04;

    // X axis — red
    axes.add(this.createAxisArrow([shaftLength, 0, 0], 0xff3333));
    const tipX = new Mesh(
      new ConeGeometry(tipRadius, tipHeight, 6),
      new MeshStandardMaterial({ color: 0xff3333, emissive: 0xff3333, emissiveIntensity: 0.5 }),
    );
    tipX.position.set(shaftLength + tipHeight / 2, 0, 0);
    tipX.rotation.z = -Math.PI / 2;
    axes.add(tipX);

    // Y axis — green
    axes.add(this.createAxisArrow([0, shaftLength, 0], 0x33ff33));
    const tipY = new Mesh(
      new ConeGeometry(tipRadius, tipHeight, 6),
      new MeshStandardMaterial({ color: 0x33ff33, emissive: 0x33ff33, emissiveIntensity: 0.5 }),
    );
    tipY.position.set(0, shaftLength + tipHeight / 2, 0);
    axes.add(tipY);

    // Z axis — blue (points toward camera = marker normal)
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
    return new Line(geom, new LineBasicMaterial({ color, linewidth: 2 }));
  }

  private disposeVisual(visual: MarkerVisual): void {
    visual.frame.geometry.dispose();
    (visual.frame.material as LineBasicMaterial).dispose();
    visual.fill.geometry.dispose();
    visual.fill.material.dispose();

    visual.axesGroup.traverse((child) => {
      if (child instanceof Line || child instanceof Mesh) {
        child.geometry.dispose();
        if (child.material instanceof MeshStandardMaterial || child.material instanceof LineBasicMaterial) {
          child.material.dispose();
        }
      }
    });

    visual.gem.geometry.dispose();
    (visual.gem.material as MeshStandardMaterial).dispose();
    visual.labelTexture.dispose();
    visual.label.material.dispose();
    this.root.remove(visual.group);
  }
}
