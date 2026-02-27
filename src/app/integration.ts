import type {
  IntegrationContext,
  InteractionAgent,
  RenderingAgent,
  TelemetryAgent,
  TopologyAgent,
  TrackingAgent
} from "../contracts/integration";

export interface AgentSuite {
  tracking?: TrackingAgent;
  topology?: TopologyAgent;
  telemetry?: TelemetryAgent;
  rendering?: RenderingAgent;
  interaction?: InteractionAgent;
}

export interface IntegrationCoordinator {
  initAll(): Promise<void>;
  disposeAll(): Promise<void>;
}

function orderedAgents(suite: AgentSuite) {
  return [
    suite.tracking,
    suite.topology,
    suite.telemetry,
    suite.rendering,
    suite.interaction
  ].filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
}

export function createIntegrationCoordinator(
  context: IntegrationContext,
  suite: AgentSuite
): IntegrationCoordinator {
  const agents = orderedAgents(suite);

  return {
    async initAll(): Promise<void> {
      for (const agent of agents) {
        await agent.init(context);
      }
    },
    async disposeAll(): Promise<void> {
      for (const agent of [...agents].reverse()) {
        await agent.dispose();
      }
    }
  };
}
