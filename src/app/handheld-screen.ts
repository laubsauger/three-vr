import { Euler, MathUtils, PerspectiveCamera, Quaternion, Vector3, WebGLRenderer } from "three";

interface HandheldScreenControllerOptions {
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  wrapper: HTMLDivElement;
  toolbar: HTMLDivElement;
  filterBar: HTMLDivElement;
  statusGrid: HTMLDivElement;
  canvasHolder: HTMLDivElement;
  onLayoutChange: () => void;
}

type OrientationPermissionState = "unknown" | "granted" | "denied" | "unsupported";

interface StyleSnapshot {
  element: HTMLElement;
  previous: Map<string, string>;
}

interface DeviceOrientationPermissionApi {
  requestPermission?: () => Promise<"granted" | "denied">;
}

const DEVICE_Z_AXIS = new Vector3(0, 0, 1);
const DEVICE_EULER = new Euler();
const DEVICE_PORTRAIT_OFFSET = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

export class HandheldScreenController {
  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly wrapper: HTMLDivElement;
  private readonly toolbar: HTMLDivElement;
  private readonly filterBar: HTMLDivElement;
  private readonly statusGrid: HTMLDivElement;
  private readonly canvasHolder: HTMLDivElement;
  private readonly onLayoutChange: () => void;
  private readonly styleSnapshots: StyleSnapshot[] = [];
  private readonly deviceQuaternion = new Quaternion();
  private readonly screenQuaternion = new Quaternion();
  private readonly dragQuaternion = new Quaternion();
  private readonly onDeviceOrientationBound = (event: DeviceOrientationEvent): void => {
    this.onDeviceOrientation(event);
  };
  private readonly onPointerDownBound = (event: PointerEvent): void => {
    this.onPointerDown(event);
  };
  private readonly onPointerMoveBound = (event: PointerEvent): void => {
    this.onPointerMove(event);
  };
  private readonly onPointerUpBound = (event: PointerEvent): void => {
    this.onPointerUp(event);
  };
  private readonly onFullscreenChangeBound = (): void => {
    if (!this.active) {
      return;
    }
    this.updateScreenOrientation();
    this.onLayoutChange();
  };
  private active = false;
  private orientationPermission: OrientationPermissionState = "unknown";
  private screenOrientationRad = 0;
  private latestOrientation:
    | {
        alpha: number;
        beta: number;
        gamma: number;
      }
    | null = null;
  private activePointerId: number | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private manualYaw = 0;
  private manualPitch = 0;

  constructor(options: HandheldScreenControllerOptions) {
    this.camera = options.camera;
    this.renderer = options.renderer;
    this.wrapper = options.wrapper;
    this.toolbar = options.toolbar;
    this.filterBar = options.filterBar;
    this.statusGrid = options.statusGrid;
    this.canvasHolder = options.canvasHolder;
    this.onLayoutChange = options.onLayoutChange;
  }

  isActive(): boolean {
    return this.active;
  }

  async enter(): Promise<void> {
    if (this.active) {
      return;
    }

    this.active = true;
    this.captureAndApplyLayout();
    this.updateScreenOrientation();
    this.bindListeners();
    this.onLayoutChange();

    const tasks = [this.requestFullscreen(), this.ensureOrientationPermission()];
    await Promise.allSettled(tasks);
    this.onLayoutChange();
  }

  async exit(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.active = false;
    this.unbindListeners();
    this.restoreLayout();
    this.latestOrientation = null;
    this.activePointerId = null;
    this.manualYaw = 0;
    this.manualPitch = 0;
    this.camera.quaternion.identity();
    this.onLayoutChange();

    if (document.fullscreenElement === this.wrapper && document.exitFullscreen) {
      try {
        await document.exitFullscreen();
      } catch {
        // Ignore fullscreen exit failures and keep the restored inline layout.
      }
    }
  }

  updateCamera(): void {
    if (!this.active) {
      return;
    }

    if (this.latestOrientation && this.orientationPermission !== "denied") {
      setObjectQuaternion(
        this.deviceQuaternion,
        this.screenQuaternion,
        this.latestOrientation.alpha,
        this.latestOrientation.beta,
        this.latestOrientation.gamma,
        this.screenOrientationRad
      );
    } else {
      this.deviceQuaternion.identity();
    }

    this.dragQuaternion.setFromEuler(new Euler(this.manualPitch, this.manualYaw, 0, "YXZ"));
    this.camera.quaternion.copy(this.deviceQuaternion).multiply(this.dragQuaternion);
  }

  private captureAndApplyLayout(): void {
    this.captureStyles(document.documentElement, {
      height: "100%",
      overflow: "hidden",
      background: "#000"
    });
    this.captureStyles(document.body, {
      margin: "0",
      height: "100%",
      overflow: "hidden",
      background: "#000"
    });
    this.captureStyles(this.wrapper, {
      position: "fixed",
      inset: "0",
      "max-width": "none",
      margin: "0",
      padding: "0",
      gap: "0",
      "min-height": "100vh",
      background: "#000",
      "z-index": "999"
    });
    this.captureStyles(this.toolbar, {
      position: "absolute",
      top: "max(12px, env(safe-area-inset-top))",
      left: "12px",
      right: "12px",
      "z-index": "4",
      padding: "8px",
      background: "rgba(5, 10, 13, 0.4)",
      border: "1px solid rgba(84, 126, 138, 0.24)",
      "backdrop-filter": "blur(8px)"
    });
    this.captureStyles(this.filterBar, {
      display: "none"
    });
    this.captureStyles(this.statusGrid, {
      display: "none"
    });
    this.captureStyles(this.canvasHolder, {
      position: "absolute",
      inset: "0",
      height: "100vh",
      "min-height": "100vh",
      "border-radius": "0",
      border: "0",
      "box-shadow": "none",
      background: "#000"
    });
    this.captureStyles(this.renderer.domElement, {
      "touch-action": "none",
      display: "block"
    });
  }

  private restoreLayout(): void {
    while (this.styleSnapshots.length > 0) {
      const snapshot = this.styleSnapshots.pop();
      if (!snapshot) {
        continue;
      }
      for (const [property, previousValue] of snapshot.previous) {
        if (previousValue) {
          snapshot.element.style.setProperty(property, previousValue);
        } else {
          snapshot.element.style.removeProperty(property);
        }
      }
    }
  }

  private captureStyles(element: HTMLElement, nextStyles: Record<string, string>): void {
    const previous = new Map<string, string>();
    for (const [property, value] of Object.entries(nextStyles)) {
      previous.set(property, element.style.getPropertyValue(property));
      element.style.setProperty(property, value);
    }
    this.styleSnapshots.push({ element, previous });
  }

  private bindListeners(): void {
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDownBound);
    window.addEventListener("pointermove", this.onPointerMoveBound);
    window.addEventListener("pointerup", this.onPointerUpBound);
    window.addEventListener("pointercancel", this.onPointerUpBound);
    window.addEventListener("deviceorientation", this.onDeviceOrientationBound);
    window.addEventListener("orientationchange", this.onFullscreenChangeBound);
    document.addEventListener("fullscreenchange", this.onFullscreenChangeBound);
  }

  private unbindListeners(): void {
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDownBound);
    window.removeEventListener("pointermove", this.onPointerMoveBound);
    window.removeEventListener("pointerup", this.onPointerUpBound);
    window.removeEventListener("pointercancel", this.onPointerUpBound);
    window.removeEventListener("deviceorientation", this.onDeviceOrientationBound);
    window.removeEventListener("orientationchange", this.onFullscreenChangeBound);
    document.removeEventListener("fullscreenchange", this.onFullscreenChangeBound);
  }

  private async requestFullscreen(): Promise<void> {
    if (!this.wrapper.requestFullscreen || document.fullscreenElement === this.wrapper) {
      return;
    }

    try {
      await this.wrapper.requestFullscreen();
    } catch {
      // Inline fullscreen is optional. The fixed-position layout still works without it.
    }
  }

  private async ensureOrientationPermission(): Promise<void> {
    if (!("DeviceOrientationEvent" in window)) {
      this.orientationPermission = "unsupported";
      return;
    }

    const permissionApi = window.DeviceOrientationEvent as typeof DeviceOrientationEvent &
      DeviceOrientationPermissionApi;
    if (typeof permissionApi.requestPermission !== "function") {
      this.orientationPermission = "granted";
      return;
    }

    try {
      const permission = await permissionApi.requestPermission();
      this.orientationPermission = permission === "granted" ? "granted" : "denied";
    } catch {
      this.orientationPermission = "denied";
    }
  }

  private onDeviceOrientation(event: DeviceOrientationEvent): void {
    if (!this.active) {
      return;
    }

    if (
      typeof event.alpha !== "number" ||
      typeof event.beta !== "number" ||
      typeof event.gamma !== "number"
    ) {
      return;
    }

    this.latestOrientation = {
      alpha: MathUtils.degToRad(event.alpha),
      beta: MathUtils.degToRad(event.beta),
      gamma: MathUtils.degToRad(event.gamma)
    };
    this.updateScreenOrientation();
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.active || event.pointerType !== "touch" || this.activePointerId !== null) {
      return;
    }

    this.activePointerId = event.pointerId;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.active || event.pointerId !== this.activePointerId) {
      return;
    }

    const deltaX = event.clientX - this.lastPointerX;
    const deltaY = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;

    this.manualYaw -= deltaX * 0.003;
    this.manualPitch = MathUtils.clamp(this.manualPitch - deltaY * 0.003, -1.35, 1.35);
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerId === this.activePointerId) {
      this.activePointerId = null;
    }
  }

  private updateScreenOrientation(): void {
    const orientation = window.screen.orientation;
    if (orientation && typeof orientation.angle === "number") {
      this.screenOrientationRad = MathUtils.degToRad(orientation.angle);
      return;
    }

    const legacyWindow = window as Window & { orientation?: number };
    this.screenOrientationRad =
      typeof legacyWindow.orientation === "number"
        ? MathUtils.degToRad(legacyWindow.orientation)
        : 0;
  }
}

function setObjectQuaternion(
  target: Quaternion,
  screenQuaternion: Quaternion,
  alpha: number,
  beta: number,
  gamma: number,
  screenOrientationRad: number
): void {
  DEVICE_EULER.set(beta, alpha, -gamma, "YXZ");
  target.setFromEuler(DEVICE_EULER);
  target.multiply(DEVICE_PORTRAIT_OFFSET);
  screenQuaternion.setFromAxisAngle(DEVICE_Z_AXIS, -screenOrientationRad);
  target.multiply(screenQuaternion);
}
