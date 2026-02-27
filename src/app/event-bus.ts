import type { AppEventMap } from "../contracts/events";
import type { AppEventBus } from "../contracts/integration";

type Handler<TPayload> = (payload: TPayload) => void;

const REPLAYABLE_EVENTS: ReadonlySet<keyof AppEventMap> = new Set([
  "topology/snapshot",
  "xr/state",
  "xr/capabilities"
]);

export function createAppEventBus(): AppEventBus {
  const handlers = new Map<keyof AppEventMap, Set<Handler<unknown>>>();
  const retainedPayloads = new Map<keyof AppEventMap, unknown>();

  const emit = <TEventName extends keyof AppEventMap>(
    eventName: TEventName,
    payload: AppEventMap[TEventName]
  ): void => {
    if (REPLAYABLE_EVENTS.has(eventName)) {
      retainedPayloads.set(eventName, payload);
    }

    const scopedHandlers = handlers.get(eventName);
    if (!scopedHandlers) {
      return;
    }

    for (const handler of scopedHandlers) {
      (handler as Handler<AppEventMap[TEventName]>)(payload);
    }
  };

  const on = <TEventName extends keyof AppEventMap>(
    eventName: TEventName,
    handler: (payload: AppEventMap[TEventName]) => void
  ): (() => void) => {
    const scopedHandlers = handlers.get(eventName) ?? new Set<Handler<unknown>>();
    scopedHandlers.add(handler as Handler<unknown>);
    handlers.set(eventName, scopedHandlers);

    if (retainedPayloads.has(eventName)) {
      const retained = retainedPayloads.get(eventName);
      (handler as Handler<unknown>)(retained as AppEventMap[TEventName]);
    }

    return () => {
      const current = handlers.get(eventName);
      if (!current) {
        return;
      }

      current.delete(handler as Handler<unknown>);
      if (current.size === 0) {
        handlers.delete(eventName);
      }
    };
  };

  return {
    emit,
    on
  };
}
