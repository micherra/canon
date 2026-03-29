import { loadAndResolveFlow, buildStateGraph } from "../orchestration/flow-parser.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

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
  projectDir?: string,
): Promise<LoadFlowResult> {
  const { flow, errors } = await loadAndResolveFlow(pluginDir, input.flow_name, projectDir);
  const state_graph = buildStateGraph(flow);

  return { flow, errors, state_graph };
}
