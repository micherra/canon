import { loadFlows, loadFlow, validateFlow } from "../flow/parser.js";
import type { FlowDefinition, FlowValidationResult } from "../flow/types.js";

export interface ListFlowsOutput {
  flows: Array<{
    name: string;
    description: string;
    step_count: number;
    has_loops: boolean;
  }>;
  total: number;
}

export async function listFlowsTool(
  projectDir: string,
  pluginDir: string
): Promise<ListFlowsOutput> {
  const flows = await loadFlows(projectDir, pluginDir);
  return {
    flows: flows.map((f) => ({
      name: f.name,
      description: f.description,
      step_count: f.steps.length,
      has_loops: f.steps.some((s) => !!s.loop_until),
    })),
    total: flows.length,
  };
}

export interface ValidateFlowOutput {
  flow_name: string;
  validation: FlowValidationResult;
}

export async function validateFlowTool(
  input: { flow_name: string },
  projectDir: string,
  pluginDir: string
): Promise<ValidateFlowOutput> {
  const flow = await loadFlow(input.flow_name, projectDir, pluginDir);
  if (!flow) {
    return {
      flow_name: input.flow_name,
      validation: {
        valid: false,
        errors: [
          {
            field: "flow_name",
            message: `Flow "${input.flow_name}" not found in .canon/flows/ or plugin flows/`,
          },
        ],
        warnings: [],
      },
    };
  }

  return {
    flow_name: flow.name,
    validation: validateFlow(flow),
  };
}
