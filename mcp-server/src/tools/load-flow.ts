import { loadAndResolveFlow, buildStateGraph } from "../orchestration/flow-parser.js";
import type { ResolvedFlow } from "../orchestration/flow-schema.js";

export interface LoadFlowInput {
  flow_name: string;
}

export interface LoadFlowResult {
  flow: ResolvedFlow;
  errors: string[];
  state_graph: Record<string, string[]>;
}

export async function loadFlow(
  input: LoadFlowInput,
  pluginDir: string,
): Promise<LoadFlowResult> {
  const { flow, errors } = await loadAndResolveFlow(pluginDir, input.flow_name);
  const state_graph = buildStateGraph(flow);

  return { flow, errors, state_graph };
}
