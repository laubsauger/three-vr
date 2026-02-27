import { WebGLRenderer } from "three";

import type {
  XrBoundaryPoint,
  XrCapabilities,
  XrFrameTick,
  XrReferenceSpaceType,
  XrRuntimeState,
  XrSessionMode,
  XrSessionStartOptions
} from "../contracts/xr";

interface NavigatorXrLike {
  isSessionSupported(mode: XrSessionMode): Promise<boolean>;
  requestSession(mode: XrSessionMode, options?: SessionInitLike): Promise<SessionLike>;
}

interface SessionInitLike {
  requiredFeatures?: string[];
  optionalFeatures?: string[];
  domOverlay?: {
    root: HTMLElement;
  };
}

interface SessionLike {
  end(): Promise<void>;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  requestReferenceSpace(type: XrReferenceSpaceType): Promise<unknown>;
}

interface BoundaryPointLike {
  x: number;
  z: number;
}

interface ReferenceSpaceLike {
  boundsGeometry?: BoundaryPointLike[];
}

const DEFAULT_REQUIRED_FEATURES = ["local-floor"];

const DEFAULT_OPTIONAL_FEATURES = [
  "local",
  "bounded-floor",
  "unbounded",
  "anchors",
  "hit-test",
  "dom-overlay",
  "hand-tracking",
  "camera-access"
];

const DEFAULT_REFERENCE_SPACE_ORDER: XrReferenceSpaceType[] = [
  "bounded-floor",
  "local-floor",
  "local",
  "viewer"
];

interface ResolvedReferenceSpace {
  type: XrReferenceSpaceType;
  space: unknown;
}

export class XrRuntime {
  private readonly renderer: WebGLRenderer;
  private readonly frameSubscribers = new Set<(tick: XrFrameTick) => void>();
  private state: XrRuntimeState = "idle";
  private session: SessionLike | null = null;
  private referenceSpace: unknown = null;
  private referenceSpaceType: XrReferenceSpaceType | null = null;
  private boundaryPolygon: XrBoundaryPoint[] | null = null;
  private frameTimeMs = 0;
  private capabilitiesCache: XrCapabilities | null = null;
  private readonly onSessionEndBound: EventListener;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.renderer.xr.enabled = true;
    this.onSessionEndBound = () => {
      void this.handleSessionEnded();
    };
  }

  getState(): XrRuntimeState {
    return this.state;
  }

  getSession(): unknown {
    return this.session;
  }

  getReferenceSpace(): unknown {
    return this.referenceSpace;
  }

  getReferenceSpaceType(): XrReferenceSpaceType | null {
    return this.referenceSpaceType;
  }

  getBoundaryPolygon(): XrBoundaryPoint[] | null {
    return this.boundaryPolygon ? this.boundaryPolygon.map((point) => ({ ...point })) : null;
  }

  subscribeFrame(handler: (tick: XrFrameTick) => void): () => void {
    this.frameSubscribers.add(handler);
    return () => this.frameSubscribers.delete(handler);
  }

  async detectCapabilities(): Promise<XrCapabilities> {
    if (this.capabilitiesCache) {
      return this.capabilitiesCache;
    }

    const xr = this.getNavigatorXr();
    if (!xr) {
      this.capabilitiesCache = {
        webxr: false,
        immersiveAr: "unsupported",
        immersiveVr: "unsupported",
        anchors: "unsupported",
        hitTest: "unsupported",
        domOverlay: "unsupported",
        handTracking: "unsupported"
      };
      return this.capabilitiesCache;
    }

    const [supportsAr, supportsVr] = await Promise.all([
      this.safeSessionSupportedCheck(xr, "immersive-ar"),
      this.safeSessionSupportedCheck(xr, "immersive-vr")
    ]);

    this.capabilitiesCache = {
      webxr: true,
      immersiveAr: supportsAr ? "supported" : "unsupported",
      immersiveVr: supportsVr ? "supported" : "unsupported",
      anchors: supportsAr ? "unknown" : "unsupported",
      hitTest: supportsAr ? "unknown" : "unsupported",
      domOverlay: supportsAr ? "unknown" : "unsupported",
      handTracking: supportsAr || supportsVr ? "unknown" : "unsupported"
    };

    return this.capabilitiesCache;
  }

  async start(options: XrSessionStartOptions = {}): Promise<void> {
    if (this.state === "running" || this.state === "requesting") {
      return;
    }

    const mode = options.mode ?? "immersive-ar";
    const xr = this.getNavigatorXr();
    if (!xr) {
      this.state = "failed";
      throw new Error("WebXR is not available in this browser.");
    }

    this.state = "requesting";

    try {
      const sessionInit = this.buildSessionInit(options);
      const session = await xr.requestSession(mode, sessionInit);

      await this.renderer.xr.setSession(session as never);
      session.addEventListener("end", this.onSessionEndBound);

      this.session = session;
      const resolved = await this.resolveReferenceSpace(
        session,
        options.referenceSpaceOrder ?? DEFAULT_REFERENCE_SPACE_ORDER
      );
      this.referenceSpace = resolved.space;
      this.referenceSpaceType = resolved.type;
      this.boundaryPolygon = this.extractBoundaryPolygon(resolved.space, resolved.type);
      this.frameTimeMs = 0;
      this.state = "running";

      this.renderer.setAnimationLoop((time: number, frame?: unknown) => {
        const deltaMs = this.frameTimeMs === 0 ? 0 : time - this.frameTimeMs;
        this.frameTimeMs = time;

        const tick: XrFrameTick = {
          time,
          deltaMs,
          frame: frame ?? null,
          referenceSpace: this.referenceSpace
        };

        for (const subscriber of this.frameSubscribers) {
          subscriber(tick);
        }
      });
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.session || this.state !== "running") {
      return;
    }

    this.state = "ending";
    const session = this.session;

    try {
      await session.end();
    } finally {
      await this.handleSessionEnded();
    }
  }

  private async handleSessionEnded(): Promise<void> {
    if (this.session) {
      this.session.removeEventListener("end", this.onSessionEndBound);
    }

    this.renderer.setAnimationLoop(null);
    this.session = null;
    this.referenceSpace = null;
    this.referenceSpaceType = null;
    this.boundaryPolygon = null;
    this.frameTimeMs = 0;
    this.state = "idle";
  }

  private buildSessionInit(options: XrSessionStartOptions): SessionInitLike {
    const requiredFeatures = options.requiredFeatures ?? DEFAULT_REQUIRED_FEATURES;
    const optionalFeatures = options.optionalFeatures ?? DEFAULT_OPTIONAL_FEATURES;

    const init: SessionInitLike = {
      requiredFeatures,
      optionalFeatures
    };

    if (options.domOverlayRoot) {
      init.domOverlay = { root: options.domOverlayRoot };
    }

    return init;
  }

  private async resolveReferenceSpace(
    session: SessionLike,
    referenceSpaceOrder: XrReferenceSpaceType[]
  ): Promise<ResolvedReferenceSpace> {
    for (const referenceType of referenceSpaceOrder) {
      try {
        const space = await session.requestReferenceSpace(referenceType);
        return {
          type: referenceType,
          space
        };
      } catch {
        continue;
      }
    }

    throw new Error("Unable to resolve a supported XR reference space.");
  }

  private extractBoundaryPolygon(
    referenceSpace: unknown,
    referenceType: XrReferenceSpaceType
  ): XrBoundaryPoint[] | null {
    if (referenceType !== "bounded-floor") {
      return null;
    }

    const maybeSpace = referenceSpace as ReferenceSpaceLike | null;
    if (!maybeSpace?.boundsGeometry || maybeSpace.boundsGeometry.length < 3) {
      return null;
    }

    return maybeSpace.boundsGeometry.map((point) => ({
      x: point.x,
      z: point.z
    }));
  }

  private getNavigatorXr(): NavigatorXrLike | null {
    const maybeNavigator = navigator as Navigator & { xr?: NavigatorXrLike };
    return maybeNavigator.xr ?? null;
  }

  private async safeSessionSupportedCheck(
    xr: NavigatorXrLike,
    mode: XrSessionMode
  ): Promise<boolean> {
    try {
      return await xr.isSessionSupported(mode);
    } catch {
      return false;
    }
  }
}
