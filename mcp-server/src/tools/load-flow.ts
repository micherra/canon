import { buildStateGraph, loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { type ToolResult, toolError, toolOk } from "../utils/tool-result.ts";

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
): Promise<ToolResult<LoadFlowResult>> {
  try {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, input.flow_name, projectDir);
    const state_graph = buildStateGraph(flow);
    return toolOk({ flow, errors, state_graph });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes("not found") ? "FLOW_NOT_FOUND" : "FLOW_PARSE_ERROR";
    return toolError(code, message);
  }
}
