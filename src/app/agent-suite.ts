import type { AgentSuite } from "./integration";
import { createTrackingAgent } from "../tracking";
import type { MarkerDetector } from "../tracking";
import { createTopologyAgent } from "../topology";
import { createTelemetryAgent } from "../telemetry";
import { createRenderingAgent } from "../rendering";
import { createInteractionAgent } from "../interaction";
import type { Camera, Scene, WebGLRenderer } from "three";

export interface DefaultAgentSuiteOptions {
  scene: Scene;
  camera: Camera;
  renderer: WebGLRenderer;
  /** Raw KML text to render as a map overlay on detected markers. */
  kmlText?: string;
  /** Custom marker detector (e.g. SwitchableDetector for toggling camera/mock). */
  detector?: MarkerDetector;
}

export function createDefaultAgentSuite(options: DefaultAgentSuiteOptions): AgentSuite {
  return {
    tracking: createTrackingAgent(options.detector ? { detector: options.detector } : undefined),
    topology: createTopologyAgent(),
    telemetry: createTelemetryAgent(),
    rendering: createRenderingAgent({
      scene: options.scene,
      kmlText: options.kmlText,
    }),
    interaction: createInteractionAgent({
      scene: options.scene,
      camera: options.camera,
      renderer: options.renderer
    })
  };
}
