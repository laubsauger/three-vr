/**
 * In-scene debug HUD rendered as a canvas-backed sprite.
 * Supports two modes:
 *   - "follow": locked to camera view (heads-up display)
 *   - "pinned": stays at its current world position
 */

import {
  Camera,
  CanvasTexture,
  Quaternion,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";

export type HudMode = "follow" | "pinned";

export interface DebugHudData {
  fps: number;
  avgFrameTimeMs: number;
  mode: "xr" | "desktop";
  markerCount: number;
  bestMarkerId: number | null;
  bestConfidence: number;
  trackingBackend: string;
  detectorStatus: string;
  xrState: string;
  // Hand tracking
  handsDetected: number;
  leftPinch: boolean;
  rightPinch: boolean;
  leftPinchStrength: number;
  rightPinchStrength: number;
  leftPoint: boolean;
  rightPoint: boolean;
  leftPointStrength: number;
  rightPointStrength: number;
  hudMode: HudMode;
  /** If set, a prominent camera warning is displayed. */
  cameraWarning: string | null;
}

export class DebugHud {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  readonly sprite: Sprite;
  private lastData: DebugHudData | null = null;
  private lastUpdateMs = 0;
  private _mode: HudMode = "follow";
  private isDragging = false;
  private readonly dragOffset = new Vector3();

  /** Offset from camera in "follow" mode (bottom-left corner). */
  private readonly followOffset = new Vector3(-0.28, -0.18, -0.5);
  private readonly tmpPos = new Vector3();
  private readonly tmpQuat = new Quaternion();
  private readonly tmpForward = new Vector3();
  private readonly tmpRight = new Vector3();
  private readonly tmpUp = new Vector3();

  /** Minimum interval between texture redraws (ms). */
  private readonly updateIntervalMs = 120;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 256;
    this.canvas.height = 200;
    this.ctx = this.canvas.getContext("2d")!;

    this.texture = new CanvasTexture(this.canvas);
    const material = new SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
    });
    this.sprite = new Sprite(material);
    this.sprite.name = "debug-hud";
    this.sprite.scale.set(0.22, 0.154, 1);

    this.drawEmpty();
  }

  get mode(): HudMode {
    return this._mode;
  }

  toggleMode(): HudMode {
    this._mode = this._mode === "follow" ? "pinned" : "follow";
    return this._mode;
  }

  setMode(mode: HudMode): void {
    this._mode = mode;
  }

  beginDrag(point: Vector3, camera?: Camera): boolean {
    if (!camera || !this.containsPoint(point, camera)) {
      return false;
    }

    this.setMode("pinned");
    this.isDragging = true;
    this.dragOffset.copy(this.sprite.position).sub(point);
    this.faceCamera(camera);
    return true;
  }

  dragTo(point: Vector3, camera?: Camera): void {
    if (!this.isDragging) {
      return;
    }

    this.sprite.position.copy(point).add(this.dragOffset);
    if (camera) {
      this.faceCamera(camera);
    }
  }

  endDrag(): void {
    this.isDragging = false;
  }

  snapToFollow(): void {
    this.isDragging = false;
    this.setMode("follow");
  }

  containsPoint(point: Vector3, camera: Camera, padding = 0.04): boolean {
    camera.getWorldQuaternion(this.tmpQuat);

    this.tmpForward.set(0, 0, -1).applyQuaternion(this.tmpQuat);
    this.tmpRight.set(1, 0, 0).applyQuaternion(this.tmpQuat);
    this.tmpUp.set(0, 1, 0).applyQuaternion(this.tmpQuat);

    this.tmpPos.copy(point).sub(this.sprite.position);
    const depth = this.tmpPos.dot(this.tmpForward);
    const x = this.tmpPos.dot(this.tmpRight);
    const y = this.tmpPos.dot(this.tmpUp);
    const halfWidth = this.sprite.scale.x * 0.5 + padding;
    const halfHeight = this.sprite.scale.y * 0.5 + padding;

    return Math.abs(depth) <= 0.18 && Math.abs(x) <= halfWidth && Math.abs(y) <= halfHeight;
  }

  /**
   * Call every frame to keep the HUD locked to the camera view.
   * Position updates run every frame; texture redraws are throttled.
   */
  update(data: DebugHudData, timeMs: number, camera?: Camera): void {
    // Always track camera position in follow mode — must run every frame
    // for the HUD to feel head-locked without jitter or lag.
    if (this._mode === "follow" && camera) {
      camera.getWorldPosition(this.tmpPos);
      camera.getWorldQuaternion(this.tmpQuat);

      this.tmpForward.set(0, 0, -1).applyQuaternion(this.tmpQuat);
      this.tmpRight.set(1, 0, 0).applyQuaternion(this.tmpQuat);
      this.tmpUp.set(0, 1, 0).applyQuaternion(this.tmpQuat);

      this.sprite.position.copy(this.tmpPos)
        .addScaledVector(this.tmpForward, -this.followOffset.z)
        .addScaledVector(this.tmpRight, this.followOffset.x)
        .addScaledVector(this.tmpUp, this.followOffset.y);
    }

    if (camera) {
      this.faceCamera(camera);
    }

    if (timeMs - this.lastUpdateMs < this.updateIntervalMs) return;
    this.lastUpdateMs = timeMs;
    this.lastData = data;
    this.redraw();
  }

  dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
  }

  private drawEmpty(): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.beginPath();
    ctx.roundRect(3, 3, w - 6, h - 6, 6);
    ctx.fill();
    ctx.font = "11px monospace";
    ctx.fillStyle = "#557788";
    ctx.textAlign = "center";
    ctx.fillText("Waiting for data...", w / 2, h / 2);
    this.texture.needsUpdate = true;
  }

  private redraw(): void {
    const data = this.lastData;
    if (!data) return;

    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "rgba(6, 12, 16, 0.82)";
    ctx.beginPath();
    ctx.roundRect(3, 3, w - 6, h - 6, 6);
    ctx.fill();

    // Border color changes based on mode
    ctx.strokeStyle = this._mode === "pinned"
      ? "rgba(255, 200, 50, 0.4)"
      : "rgba(0, 255, 136, 0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(3, 3, w - 6, h - 6, 6);
    ctx.stroke();

    let y = 16;
    const lineH = 14;
    const left = 8;
    const right = w - 8;

    // Title + mode badge
    ctx.font = "bold 9px monospace";
    ctx.fillStyle = "#00ff88";
    ctx.textAlign = "left";
    ctx.fillText("DBG", left, y);

    const modeLabel = this._mode === "follow" ? "F" : "P";
    const modeColor = this._mode === "follow" ? "#00ff88" : "#ffcc33";
    ctx.font = "8px monospace";
    ctx.fillStyle = modeColor;
    ctx.textAlign = "right";
    ctx.fillText(modeLabel, right, y);

    y += lineH;

    // Compact rows
    const row = (label: string, value: string, valueColor: string) => {
      ctx.textAlign = "left";
      ctx.font = "8px monospace";
      ctx.fillStyle = "#7799aa";
      ctx.fillText(label, left, y);
      ctx.textAlign = "right";
      ctx.fillStyle = valueColor;
      ctx.fillText(value, right, y);
      y += lineH;
    };

    const fpsColor = data.fps >= 60 ? "#00ff88" : data.fps >= 30 ? "#ffcc33" : "#ff4444";
    row("FPS", `${data.fps.toFixed(0)} (${data.avgFrameTimeMs.toFixed(1)}ms)`, fpsColor);
    row("XR", data.xrState, data.xrState === "running" ? "#00ff88" : "#ffcc33");

    // Tracking — condensed
    const detShort = data.detectorStatus === "ready" ? "ok" : data.detectorStatus;
    row("Track", `${data.trackingBackend} ${detShort}`,
      data.detectorStatus === "ready" ? "#00ff88" : "#ffcc33");

    // Markers
    if (data.markerCount > 0) {
      row("Mkr", `${data.markerCount} #${data.bestMarkerId ?? "?"} ${(data.bestConfidence * 100).toFixed(0)}%`, "#00ff88");
    } else {
      row("Mkr", "---", "#ff6644");
    }

    // Separator
    ctx.strokeStyle = "rgba(85, 119, 136, 0.25)";
    ctx.beginPath();
    ctx.moveTo(left, y - 4);
    ctx.lineTo(right, y - 4);
    ctx.stroke();
    y += 2;

    // Hands — compact with pinch + point
    if (data.handsDetected > 0) {
      const lPinch = renderBar(data.leftPinchStrength, 4);
      const lPoint = data.leftPoint ? " PTR" : "";
      const rPinch = renderBar(data.rightPinchStrength, 4);
      const rPoint = data.rightPoint ? " PTR" : "";
      const lColor = data.leftPinch ? "#00ffcc" : data.leftPoint ? "#ffaa33" : "#7799aa";
      const rColor = data.rightPinch ? "#00ffcc" : data.rightPoint ? "#ffaa33" : "#7799aa";
      row("L", `${lPinch}${lPoint}`, lColor);
      row("R", `${rPinch}${rPoint}`, rColor);
    } else {
      row("Hands", "---", "#556677");
    }

    // Best marker lock line
    if (data.bestMarkerId != null && data.markerCount > 0) {
      y += 2;
      ctx.font = "bold 9px monospace";
      ctx.fillStyle = "#00ff88";
      ctx.textAlign = "center";
      ctx.fillText(`LOCK #${data.bestMarkerId}`, w / 2, y);
    }

    // Camera warning — prominent red bar
    if (data.cameraWarning) {
      y += 6;
      ctx.fillStyle = "rgba(180, 30, 30, 0.85)";
      ctx.beginPath();
      ctx.roundRect(left, y - 10, w - 16, 16, 3);
      ctx.fill();
      ctx.font = "bold 8px monospace";
      ctx.fillStyle = "#ffcccc";
      ctx.textAlign = "center";
      ctx.fillText(data.cameraWarning, w / 2, y + 1);
    }

    this.texture.needsUpdate = true;
  }

  private faceCamera(camera: Camera): void {
    camera.getWorldQuaternion(this.tmpQuat);
    this.sprite.quaternion.copy(this.tmpQuat);
  }
}

function renderBar(strength: number, segments = 5): string {
  const filled = Math.round(strength * segments);
  return "\u2588".repeat(filled) + "\u2591".repeat(segments - filled);
}
