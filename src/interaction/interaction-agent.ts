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
type VisualState = "none" | "hover" | "selected";
interface MaterialBaseline {
  colorHex?: number;
  emissiveHex?: number;
  emissiveIntensity?: number;
  opacity?: number;
}

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
    position: { x: number; y: number; z: number };
    orientation: { x: number; y: number; z: number; w: number };
  };
}

interface FrameLike {
  getPose(space: unknown, referenceSpace: unknown): PoseLike | null;
}

interface InputSourceEventLike {
  frame: unknown;
  inputSource: unknown;
}

/** Proximity radius for hover detection around the index fingertip. */
const HOVER_PROXIMITY_RADIUS = 0.18;
/** Direct intersection radius for any tracked hand joint. */
const HAND_INTERSECTION_RADIUS = 0.1;
/** Max distance for finger-pointing ray hover. */
const HOVER_RAY_MAX_DISTANCE = 3.0;

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

  // Reusable math objects
  const pointer = new Vector2();
  const rayOrigin = new Vector3();
  const rayDirection = new Vector3();
  const orientation = new Quaternion();
  const tmpWorldPos = new Vector3();
  const fingerTipPos = new Vector3();
  const fingerRayDir = new Vector3();

  // Selection state
  let selectedObject: Object3D | null = null;
  let selectedNodeId: string | null = null;
  let selectedLinkId: string | null = null;

  // Hover state
  let hoveredObject: Object3D | null = null;
  let hoveredTarget: SelectableTarget | null = null;

  // Listener handles
  let onPointerDown: ((event: PointerEvent) => void) | null = null;
  let onPointerMove: ((event: PointerEvent) => void) | null = null;
  let onXrSelectStart: EventListener | null = null;
  let onXrSqueezeStart: EventListener | null = null;
  let unsubscribeXrState: (() => void) | null = null;
  let unsubscribeXrFrame: (() => void) | null = null;
  let unsubscribePinch: (() => void) | null = null;
  let unsubscribePoint: (() => void) | null = null;
  let activeSession: SessionLike | null = null;

  const materialBaselines = new WeakMap<Material, MaterialBaseline>();
  const handTracker = new HandTracker();

  // ---- Visual state management ----

  const resolveState = (object: Object3D): VisualState => {
    if (object === selectedObject) return "selected";
    if (object === hoveredObject) return "hover";
    return "none";
  };

  const applyVisualState = (object: Object3D, state: VisualState): void => {
    object.traverse((entry) => {
      const apply = (mat: Material) => applyMaterialState(mat, state, materialBaselines);
      const material = (entry as Object3D & { material?: Material | Material[] }).material;
      if (!material) {
        return;
      }
      if (Array.isArray(material)) {
        for (const item of material) {
          apply(item);
        }
      } else {
        apply(material);
      }
    });
  };

  const refreshVisual = (object: Object3D): void => {
    applyVisualState(object, resolveState(object));
  };

  // ---- Hover ----

  const updateHover = (context: IntegrationContext, next: SelectableTarget | null): void => {
    if ((next?.object ?? null) === hoveredObject) return;

    const prevObj = hoveredObject;
    hoveredObject = next?.object ?? null;
    hoveredTarget = next;

    if (prevObj) refreshVisual(prevObj);
    if (hoveredObject) refreshVisual(hoveredObject);

    context.events.emit("interaction/hover", {
      kind: next?.kind ?? null,
      id: next?.id ?? null,
      timestampMs: performance.now(),
    });
  };

  // ---- Selection ----

  const updateSelection = (context: IntegrationContext, next: SelectableTarget | null): void => {
    const prevObj = selectedObject;
    selectedObject = next?.object ?? null;
    selectedNodeId = next?.kind === "node" ? next.id : null;
    selectedLinkId = next?.kind === "link" ? next.id : null;

    if (prevObj) refreshVisual(prevObj);
    if (selectedObject) refreshVisual(selectedObject);

    context.events.emit("interaction/selection-change", {
      selectedNodeId,
      selectedLinkId,
      timestampMs: performance.now()
    });
  };

  // ---- Picking helpers ----

  const pickFromRay = (origin: Vector3, direction: Vector3, maxDistance?: number): SelectableTarget | null => {
    raycaster.set(origin, direction.normalize());
    raycaster.camera = options.renderer.xr.isPresenting
      ? options.renderer.xr.getCamera()
      : options.camera;
    const prevFar = raycaster.far;
    if (maxDistance != null) raycaster.far = maxDistance;
    const intersections = raycaster.intersectObjects(options.scene.children, true);
    raycaster.far = prevFar;
    return pickFirstSelectable(intersections.map((entry) => entry.object));
  };

  const pickFromProximity = (point: Vector3, radius: number): (SelectableTarget & { distSq: number }) | null => {
    let bestTarget: (SelectableTarget & { distSq: number }) | null = null;
    let bestDistSq = radius * radius;

    options.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;

      const target = resolveSelectableTarget(object);
      if (!target) return;

      object.getWorldPosition(tmpWorldPos);
      const distSq = tmpWorldPos.distanceToSquared(point);
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestTarget = { ...target, distSq };
      }
    });

    return bestTarget;
  };

  const pickDirectHoverFromHand = (joints: Array<{ name: string; position: { x: number; y: number; z: number } }>): SelectableTarget | null => {
    let bestHit: (SelectableTarget & { distSq: number }) | null = null;

    for (const joint of joints) {
      fingerTipPos.set(joint.position.x, joint.position.y, joint.position.z);
      const hit = pickFromProximity(fingerTipPos, HAND_INTERSECTION_RADIUS);
      if (hit && (!bestHit || hit.distSq < bestHit.distSq)) {
        bestHit = hit;
      }
    }

    if (!bestHit) {
      return null;
    }

    return {
      kind: bestHit.kind,
      id: bestHit.id,
      object: bestHit.object,
    };
  };

  /** Hover check using right hand: proximity from index tip, then finger pointing ray. */
  const pickHoverFromHand = (joints: Array<{ name: string; position: { x: number; y: number; z: number } }>): SelectableTarget | null => {
    const directTarget = pickDirectHoverFromHand(joints);
    if (directTarget) return directTarget;

    const indexTip = joints.find((j) => j.name === "index-finger-tip");
    if (!indexTip) return null;

    fingerTipPos.set(indexTip.position.x, indexTip.position.y, indexTip.position.z);

    // Near: proximity from fingertip
    const nearTarget = pickFromProximity(fingerTipPos, HOVER_PROXIMITY_RADIUS);
    if (nearTarget) {
      return {
        kind: nearTarget.kind,
        id: nearTarget.id,
        object: nearTarget.object,
      };
    }

    // Far: ray along finger direction (distal → tip)
    const indexDistal = joints.find((j) => j.name === "index-finger-phalanx-distal");
    if (!indexDistal) return null;

    fingerRayDir.set(
      indexTip.position.x - indexDistal.position.x,
      indexTip.position.y - indexDistal.position.y,
      indexTip.position.z - indexDistal.position.z,
    ).normalize();

    return pickFromRay(fingerTipPos, fingerRayDir, HOVER_RAY_MAX_DISTANCE);
  };

  // ---- XR controller pick ----

  const pickFromInputSourceEvent = (
    context: IntegrationContext,
    event: InputSourceEventLike
  ): void => {
    const frame = asFrame(event.frame);
    const inputSource = asInputSource(event.inputSource);
    const referenceSpace = context.xrRuntime.getReferenceSpace();
    if (!frame || !inputSource || !referenceSpace || !inputSource.targetRaySpace) return;

    const pose = frame.getPose(inputSource.targetRaySpace, referenceSpace);
    if (!pose) return;

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

  // ---- XR session listeners (for controllers) ----

  const detachSessionListeners = (): void => {
    if (!activeSession) return;
    if (onXrSelectStart) activeSession.removeEventListener("selectstart", onXrSelectStart);
    if (onXrSqueezeStart) activeSession.removeEventListener("squeezestart", onXrSqueezeStart);
    activeSession = null;
  };

  const attachSessionListeners = (
    context: IntegrationContext,
    maybeSession: unknown
  ): void => {
    const session = asSession(maybeSession);
    if (!session || session === activeSession) return;

    detachSessionListeners();

    onXrSelectStart = (event: Event) => {
      const inputEvent = asInputSourceEvent(event);
      if (inputEvent) pickFromInputSourceEvent(context, inputEvent);
    };
    onXrSqueezeStart = (event: Event) => {
      const inputEvent = asInputSourceEvent(event);
      if (inputEvent) pickFromInputSourceEvent(context, inputEvent);
    };

    session.addEventListener("selectstart", onXrSelectStart);
    session.addEventListener("squeezestart", onXrSqueezeStart);
    activeSession = session;
  };

  // ---- Agent lifecycle ----

  return {
    async init(context: IntegrationContext): Promise<void> {
      // Desktop: click to select
      onPointerDown = (event: PointerEvent) => {
        const canvas = options.renderer.domElement;
        const bounds = canvas.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) return;

        pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
        pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
        raycaster.setFromCamera(pointer, options.camera);
        updateSelection(context, pickFromRay(raycaster.ray.origin, raycaster.ray.direction));
      };

      // Desktop: move to hover
      onPointerMove = (event: PointerEvent) => {
        const canvas = options.renderer.domElement;
        const bounds = canvas.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) return;

        pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
        pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
        raycaster.setFromCamera(pointer, options.camera);
        const target = pickFromRay(raycaster.ray.origin, raycaster.ray.direction);
        updateHover(context, target);
        canvas.style.cursor = target ? "pointer" : "default";
      };

      options.renderer.domElement.addEventListener("pointerdown", onPointerDown);
      options.renderer.domElement.addEventListener("pointermove", onPointerMove);

      unsubscribeXrState = context.events.on("xr/state", (payload) => {
        if (payload.state === "running") {
          attachSessionListeners(context, context.xrRuntime.getSession());
        } else {
          detachSessionListeners();
        }
      });

      // Per-frame hand tracking + hover
      unsubscribeXrFrame = context.events.on("xr/frame", (tick) => {
        if (!tick.frame || !tick.referenceSpace) return;

        const hands = handTracker.readHands(tick.frame, tick.referenceSpace);
        if (!hands) {
          // No hands detected → clear hover
          if (hoveredObject) updateHover(context, null);
          return;
        }

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

        for (const transition of handTracker.getPointTransitions(hands)) {
          context.events.emit("interaction/point", {
            hand: transition.hand,
            state: transition.state,
            position: transition.position,
            direction: transition.direction,
            timestampMs: tick.time,
          });
        }

        let target: SelectableTarget | null = null;

        for (const hand of hands) {
          target = pickDirectHoverFromHand(hand.joints);
          if (target) {
            break;
          }
        }

        if (!target) {
          const rightHand = hands.find((h) => h.hand === "right");
          if (rightHand) {
            target = pickHoverFromHand(rightHand.joints);
          }
        }

        updateHover(context, target);
      });

      // Right-hand pinch → select current hover target (or deselect)
      unsubscribePinch = context.events.on("interaction/pinch", (payload) => {
        if (payload.hand !== "right" || payload.state !== "start") return;
        updateSelection(context, hoveredTarget);
      });

      // Right-hand point → select via pointing ray
      unsubscribePoint = context.events.on("interaction/point", (payload) => {
        if (payload.hand !== "right" || payload.state !== "start") return;
        fingerTipPos.set(payload.position.x, payload.position.y, payload.position.z);
        fingerRayDir.set(payload.direction.x, payload.direction.y, payload.direction.z);
        const target = pickFromRay(fingerTipPos, fingerRayDir, HOVER_RAY_MAX_DISTANCE);
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
      if (unsubscribePoint) {
        unsubscribePoint();
        unsubscribePoint = null;
      }
      handTracker.reset();
      detachSessionListeners();

      if (onPointerDown) {
        options.renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        onPointerDown = null;
      }
      if (onPointerMove) {
        options.renderer.domElement.removeEventListener("pointermove", onPointerMove);
        onPointerMove = null;
      }
      if (selectedObject) {
        refreshVisual(selectedObject);
        selectedObject = null;
      }
      if (hoveredObject) {
        refreshVisual(hoveredObject);
        hoveredObject = null;
        hoveredTarget = null;
      }
    }
  };
}

// ---- Type narrowing helpers ----

function asSession(value: unknown): SessionLike | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SessionLike>;
  if (
    typeof candidate.addEventListener !== "function" ||
    typeof candidate.removeEventListener !== "function"
  ) return null;
  return candidate as SessionLike;
}

function asFrame(value: unknown): FrameLike | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<FrameLike>;
  if (typeof candidate.getPose !== "function") return null;
  return candidate as FrameLike;
}

function asInputSource(value: unknown): InputSourceLike | null {
  if (!value || typeof value !== "object") return null;
  return value as InputSourceLike;
}

function asInputSourceEvent(value: unknown): InputSourceEventLike | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<InputSourceEventLike>;
  if (!("frame" in candidate) || !("inputSource" in candidate)) return null;
  return candidate as InputSourceEventLike;
}

// ---- Scene picking helpers ----

function pickFirstSelectable(intersections: Object3D[]): SelectableTarget | null {
  for (const object of intersections) {
    const target = resolveSelectableTarget(object);
    if (target) {
      return target;
    }
  }
  return null;
}

function resolveSelectableTarget(object: Object3D): SelectableTarget | null {
  let cursor: Object3D | null = object;
  while (cursor) {
    const selectableType = readSelectableType(cursor);
    const selectableId = readSelectableId(cursor);
    if (selectableType && selectableId) {
      return { kind: selectableType, id: selectableId, object: cursor };
    }
    cursor = cursor.parent;
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

// ---- Material state application ----

function applyMaterialState(
  material: Material,
  state: VisualState,
  baselines: WeakMap<Material, MaterialBaseline>
): void {
  if (material instanceof MeshStandardMaterial) {
    if (!baselines.has(material)) {
      baselines.set(material, readMaterialBaseline(material));
    }
    if (state === "selected") {
      material.emissive.setHex(0x2c6b8b);
      material.emissiveIntensity = 0.9;
    } else if (state === "hover") {
      material.emissive.setHex(0x1a5566);
      material.emissiveIntensity = 0.45;
    } else {
      const baseline = readMaterialBaseline(material, baselines.get(material));
      if (baseline?.emissiveHex != null) {
        material.emissive.setHex(baseline.emissiveHex);
      }
      if (baseline?.emissiveIntensity != null) {
        material.emissiveIntensity = baseline.emissiveIntensity;
      }
      if (baseline?.colorHex != null) {
        material.color.setHex(baseline.colorHex);
      }
    }
    return;
  }

  if (material instanceof LineBasicMaterial) {
    if (!baselines.has(material)) {
      baselines.set(material, readMaterialBaseline(material));
    }
    if (state === "selected") {
      material.color.setHex(0x72e1ff);
      material.opacity = 1;
    } else if (state === "hover") {
      material.color.setHex(0x55ccee);
      material.opacity = 0.9;
    } else {
      const baseline = readMaterialBaseline(material, baselines.get(material));
      if (baseline?.colorHex != null) {
        material.color.setHex(baseline.colorHex);
      }
      if (baseline?.opacity != null) {
        material.opacity = baseline.opacity;
      }
    }
  }
}

function readMaterialBaseline(material: Material, fallback?: MaterialBaseline): MaterialBaseline {
  const userDataBase = (material.userData as { interactionBase?: MaterialBaseline }).interactionBase;
  if (userDataBase) {
    return userDataBase;
  }

  if (fallback) {
    return fallback;
  }

  if (material instanceof MeshStandardMaterial) {
    return {
      colorHex: material.color.getHex(),
      emissiveHex: material.emissive.getHex(),
      emissiveIntensity: material.emissiveIntensity,
    };
  }

  if (material instanceof LineBasicMaterial) {
    return {
      colorHex: material.color.getHex(),
      opacity: material.opacity,
    };
  }

  return {};
}
