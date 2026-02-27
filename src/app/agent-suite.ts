import type { AgentSuite } from "./integration";
import { createTrackingAgent } from "../tracking";
import { createTopologyAgent } from "../topology";
import { createTelemetryAgent } from "../telemetry";
import { createRenderingAgent } from "../rendering";
import { createInteractionAgent } from "../interaction";
import type { Camera, Scene, WebGLRenderer } from "three";

export interface DefaultAgentSuiteOptions {
  scene: Scene;
  camera: Camera;
  renderer: WebGLRenderer;
}

export function createDefaultAgentSuite(options: DefaultAgentSuiteOptions): AgentSuite {
  return {
    tracking: createTrackingAgent(),
    topology: createTopologyAgent(),
    telemetry: createTelemetryAgent(),
    rendering: createRenderingAgent({
      scene: options.scene
    }),
    interaction: createInteractionAgent({
      scene: options.scene,
      camera: options.camera,
      renderer: options.renderer
    })
  };
}
