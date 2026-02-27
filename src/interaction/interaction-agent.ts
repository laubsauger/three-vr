import {
  Camera,
  LineBasicMaterial,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Raycaster,
  Scene,
  Vector3,
  Vector2,
  WebGLRenderer
} from "three";

import type { IntegrationContext, InteractionAgent } from "../contracts/integration";
import { HandTracker } from "./hand-tracking";

type SelectableKind = "node" | "link";

interface SelectableTarget {
  kind: SelectableKind;
  id: string;
  object: Object3D;
}

interface SessionLike {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface InputSourceLike {
  targetRaySpace?: unknown;
}

interface PoseLike {
  transform: {
    position: {
      x: number;
      y: number;
      z: number;
    };
    orientation: {
      x: number;
      y: number;
      z: number;
      w: number;
    };
  };
}

interface FrameLike {
  getPose(space: unknown, referenceSpace: unknown): PoseLike | null;
}

interface InputSourceEventLike {
  frame: unknown;
  inputSource: unknown;
}

export interface InteractionAgentOptions {
  scene: Scene;
  camera: Camera;
  renderer: WebGLRenderer;
}

export function createInteractionAgent(options: InteractionAgentOptions): InteractionAgent {
  const raycaster = new Raycaster();
  raycaster.params.Line = {
    ...raycaster.params.Line,
    threshold: 0.12
  };

  const pointer = new Vector2();
  const rayOrigin = new Vector3();
  const rayDirection = new Vector3();
  const orientation = new Quaternion();
  let selectedObject: Object3D | null = null;
  let selectedNodeId: string | null = null;
  let selectedLinkId: string | null = null;
  let onPointerDown: ((event: PointerEvent) => void) | null = null;
  let onXrSelectStart: EventListener | null = null;
  let onXrSqueezeStart: EventListener | null = null;
  let unsubscribeXrState: (() => void) | null = null;
  let unsubscribeXrFrame: (() => void) | null = null;
  let unsubscribePinch: (() => void) | null = null;
  let activeSession: SessionLike | null = null;
  const defaultColors = new WeakMap<Material, number>();
  const handTracker = new HandTracker();
  const tmpWorldPos = new Vector3();
  const PINCH_PICK_RADIUS = 0.15;

  const setHighlighted = (object: Object3D, highlighted: boolean): void => {
    if (object instanceof Mesh) {
      const material = object.material;
      if (Array.isArray(material)) {
        for (const item of material) {
          applyHighlightToMaterial(item, highlighted, defaultColors);
        }
      } else {
        applyHighlightToMaterial(material, highlighted, defaultColors);
      }
      return;
    }

    const maybeMaterial = (object as Object3D & { material?: Material | Material[] }).material;
    if (!maybeMaterial) {
      return;
    }

    if (Array.isArray(maybeMaterial)) {
      for (const item of maybeMaterial) {
        applyHighlightToMaterial(item, highlighted, defaultColors);
      }
    } else {
      applyHighlightToMaterial(maybeMaterial, highlighted, defaultColors);
    }
  };

  const updateSelection = (context: IntegrationContext, next: SelectableTarget | null): void => {
    if (selectedObject) {
      setHighlighted(selectedObject, false);
      selectedObject = null;
    }

    if (!next) {
      selectedNodeId = null;
      selectedLinkId = null;
      context.events.emit("interaction/selection-change", {
        selectedNodeId,
        selectedLinkId,
        timestampMs: performance.now()
      });
      return;
    }

    selectedObject = next.object;
    setHighlighted(next.object, true);
    selectedNodeId = next.kind === "node" ? next.id : null;
    selectedLinkId = next.kind === "link" ? next.id : null;
    context.events.emit("interaction/selection-change", {
      selectedNodeId,
      selectedLinkId,
      timestampMs: performance.now()
    });
  };

  const pickFromRay = (origin: Vector3, direction: Vector3): SelectableTarget | null => {
    raycaster.set(origin, direction.normalize());
    const intersections = raycaster.intersectObjects(options.scene.children, true);
    return pickFirstSelectable(intersections.map((entry) => entry.object));
  };

  const pickFromProximity = (point: Vector3): SelectableTarget | null => {
    let bestTarget: SelectableTarget | null = null;
    let bestDistSq = PINCH_PICK_RADIUS * PINCH_PICK_RADIUS;

    options.scene.traverse((object) => {
      const selectableType = readSelectableType(object);
      const selectableId = readSelectableId(object);
      if (!selectableType || !selectableId) return;

      object.getWorldPosition(tmpWorldPos);
      const distSq = tmpWorldPos.distanceToSquared(point);
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestTarget = { kind: selectableType, id: selectableId, object };
      }
    });

    return bestTarget;
  };

  const pickFromInputSourceEvent = (
    context: IntegrationContext,
    event: InputSourceEventLike
  ): void => {
    const frame = asFrame(event.frame);
    const inputSource = asInputSource(event.inputSource);
    const referenceSpace = context.xrRuntime.getReferenceSpace();
    if (!frame || !inputSource || !referenceSpace || !inputSource.targetRaySpace) {
      return;
    }

    const pose = frame.getPose(inputSource.targetRaySpace, referenceSpace);
    if (!pose) {
      return;
    }

    rayOrigin.set(
      pose.transform.position.x,
      pose.transform.position.y,
      pose.transform.position.z
    );
    orientation.set(
      pose.transform.orientation.x,
      pose.transform.orientation.y,
      pose.transform.orientation.z,
      pose.transform.orientation.w
    );
    rayDirection.set(0, 0, -1).applyQuaternion(orientation).normalize();
    updateSelection(context, pickFromRay(rayOrigin, rayDirection));
  };

  const detachSessionListeners = (): void => {
    if (!activeSession) {
      return;
    }
    if (onXrSelectStart) {
      activeSession.removeEventListener("selectstart", onXrSelectStart);
    }
    if (onXrSqueezeStart) {
      activeSession.removeEventListener("squeezestart", onXrSqueezeStart);
    }
    activeSession = null;
  };

  const attachSessionListeners = (
    context: IntegrationContext,
    maybeSession: unknown
  ): void => {
    const session = asSession(maybeSession);
    if (!session || session === activeSession) {
      return;
    }

    detachSessionListeners();

    onXrSelectStart = (event: Event) => {
      const inputEvent = asInputSourceEvent(event);
      if (!inputEvent) {
        return;
      }
      pickFromInputSourceEvent(context, inputEvent);
    };
    onXrSqueezeStart = (event: Event) => {
      const inputEvent = asInputSourceEvent(event);
      if (!inputEvent) {
        return;
      }
      pickFromInputSourceEvent(context, inputEvent);
    };

    session.addEventListener("selectstart", onXrSelectStart);
    session.addEventListener("squeezestart", onXrSqueezeStart);
    activeSession = session;
  };

  return {
    async init(context: IntegrationContext): Promise<void> {
      onPointerDown = (event: PointerEvent) => {
        const canvas = options.renderer.domElement;
        const bounds = canvas.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) {
          return;
        }

        pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
        pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
        raycaster.setFromCamera(pointer, options.camera);
        const ray = raycaster.ray;
        updateSelection(context, pickFromRay(ray.origin, ray.direction));
      };

      options.renderer.domElement.addEventListener("pointerdown", onPointerDown);

      unsubscribeXrState = context.events.on("xr/state", (payload) => {
        if (payload.state === "running") {
          attachSessionListeners(context, context.xrRuntime.getSession());
        } else {
          detachSessionListeners();
        }
      });

      // Per-frame hand tracking
      unsubscribeXrFrame = context.events.on("xr/frame", (tick) => {
        if (!tick.frame || !tick.referenceSpace) return;

        const hands = handTracker.readHands(tick.frame, tick.referenceSpace);
        if (!hands) return;

        context.events.emit("interaction/hands", {
          hands,
          timestampMs: tick.time,
        });

        for (const transition of handTracker.getPinchTransitions(hands)) {
          context.events.emit("interaction/pinch", {
            hand: transition.hand,
            state: transition.state,
            position: transition.position,
            timestampMs: tick.time,
          });
        }
      });

      // Right-hand pinch selects nearest object
      unsubscribePinch = context.events.on("interaction/pinch", (payload) => {
        if (payload.hand !== "right" || payload.state !== "start") return;
        const pinchPos = new Vector3(payload.position.x, payload.position.y, payload.position.z);
        const target = pickFromProximity(pinchPos);
        updateSelection(context, target);
      });

      if (context.xrRuntime.getState() === "running") {
        attachSessionListeners(context, context.xrRuntime.getSession());
      }
    },

    async dispose(): Promise<void> {
      if (unsubscribeXrState) {
        unsubscribeXrState();
        unsubscribeXrState = null;
      }
      if (unsubscribeXrFrame) {
        unsubscribeXrFrame();
        unsubscribeXrFrame = null;
      }
      if (unsubscribePinch) {
        unsubscribePinch();
        unsubscribePinch = null;
      }
      handTracker.reset();
      detachSessionListeners();

      if (onPointerDown) {
        options.renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        onPointerDown = null;
      }
      if (selectedObject) {
        setHighlighted(selectedObject, false);
        selectedObject = null;
      }
    }
  };
}

function asSession(value: unknown): SessionLike | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<SessionLike>;
  if (
    typeof candidate.addEventListener !== "function" ||
    typeof candidate.removeEventListener !== "function"
  ) {
    return null;
  }
  return candidate as SessionLike;
}

function asFrame(value: unknown): FrameLike | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<FrameLike>;
  if (typeof candidate.getPose !== "function") {
    return null;
  }
  return candidate as FrameLike;
}

function asInputSource(value: unknown): InputSourceLike | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as InputSourceLike;
}

function asInputSourceEvent(value: unknown): InputSourceEventLike | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<InputSourceEventLike>;
  if (!("frame" in candidate) || !("inputSource" in candidate)) {
    return null;
  }
  return candidate as InputSourceEventLike;
}

function pickFirstSelectable(intersections: Object3D[]): SelectableTarget | null {
  for (const object of intersections) {
    let cursor: Object3D | null = object;
    while (cursor) {
      const selectableType = readSelectableType(cursor);
      const selectableId = readSelectableId(cursor);
      if (selectableType && selectableId) {
        return {
          kind: selectableType,
          id: selectableId,
          object: cursor
        };
      }
      cursor = cursor.parent;
    }
  }
  return null;
}

function readSelectableType(object: Object3D): SelectableKind | null {
  const value = (object.userData as { selectableType?: unknown }).selectableType;
  return value === "node" || value === "link" ? value : null;
}

function readSelectableId(object: Object3D): string | null {
  const value = (object.userData as { selectableId?: unknown }).selectableId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function applyHighlightToMaterial(
  material: Material,
  highlighted: boolean,
  defaultColors: WeakMap<Material, number>
): void {
  if (material instanceof MeshStandardMaterial) {
    if (!defaultColors.has(material)) {
      defaultColors.set(material, material.color.getHex());
    }
    if (highlighted) {
      material.emissive.setHex(0x2c6b8b);
      material.emissiveIntensity = 0.9;
    } else {
      material.emissive.setHex(0x000000);
      material.emissiveIntensity = 0;
      const original = defaultColors.get(material);
      if (typeof original === "number") {
        material.color.setHex(original);
      }
    }
    return;
  }

  if (material instanceof LineBasicMaterial) {
    if (!defaultColors.has(material)) {
      defaultColors.set(material, material.color.getHex());
    }
    if (highlighted) {
      material.color.setHex(0x72e1ff);
      material.opacity = 1;
    } else {
      const original = defaultColors.get(material);
      if (typeof original === "number") {
        material.color.setHex(original);
      }
      material.opacity = 0.8;
    }
  }
}
