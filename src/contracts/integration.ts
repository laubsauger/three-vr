import type { AppEventMap } from "./events";
import type { XrCapabilities, XrRuntimeState, XrSessionStartOptions } from "./xr";

export interface AppEventBus {
  emit<TEventName extends keyof AppEventMap>(
    eventName: TEventName,
    payload: AppEventMap[TEventName]
  ): void;
  on<TEventName extends keyof AppEventMap>(
    eventName: TEventName,
    handler: (payload: AppEventMap[TEventName]) => void
  ): () => void;
}

export interface IntegrationContext {
  events: AppEventBus;
  xrRuntime: XrRuntimePort;
}

export interface XrRuntimePort {
  getState(): XrRuntimeState;
  getSession(): unknown;
  getReferenceSpace(): unknown;
  detectCapabilities(): Promise<XrCapabilities>;
  start(options?: XrSessionStartOptions): Promise<void>;
  stop(): Promise<void>;
  subscribeFrame(
    handler: (tick: AppEventMap["xr/frame"]) => void
  ): () => void;
}

export interface TrackingAgent {
  init(context: IntegrationContext): Promise<void>;
  dispose(): Promise<void>;
}

export interface TopologyAgent {
  init(context: IntegrationContext): Promise<void>;
  dispose(): Promise<void>;
}

export interface RenderingAgent {
  init(context: IntegrationContext): Promise<void>;
  dispose(): Promise<void>;
}

export interface InteractionAgent {
  init(context: IntegrationContext): Promise<void>;
  dispose(): Promise<void>;
}

export interface TelemetryAgent {
  init(context: IntegrationContext): Promise<void>;
  dispose(): Promise<void>;
}
