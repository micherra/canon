import { readFile, readdir } from "fs/promises";
import { join, basename } from "path";
import type {
  FlowDefinition,
  FlowStep,
  FlowValidationResult,
  FlowValidationError,
} from "./types.js";

/**
 * Parse a YAML-like flow definition from a string.
 *
 * Canon flows use a simple YAML subset. We parse this without a YAML
 * library to avoid adding dependencies. The format is intentionally
 * constrained — not arbitrary YAML.
 *
 * For robustness, this parser handles the key structures needed:
 * - Top-level scalar fields (name, description, max_iterations)
 * - steps array with nested objects
 */
export function parseFlowYaml(content: string): FlowDefinition {
  const lines = content.split("\n");
  let name = "";
  let description = "";
  let maxIterations: number | undefined;
  const steps: FlowStep[] = [];

  let inSteps = false;
  let currentStep: Partial<FlowStep> | null = null;
  let inSubSteps: "on_violation" | "on_failure" | null = null;
  let subSteps: FlowStep[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");

    // Skip comments and empty lines
    if (line.trim().startsWith("#") || line.trim() === "") continue;

    // Top-level fields
    if (!inSteps) {
      if (line.startsWith("name:")) {
        name = line.slice(5).trim().replace(/^(["'])(.+)\1$/, "$2");
        continue;
      }
      if (line.startsWith("description:")) {
        description = line.slice(12).trim().replace(/^(["'])(.+)\1$/, "$2");
        continue;
      }
      if (line.startsWith("max_iterations:")) {
        maxIterations = parseInt(line.slice(15).trim(), 10);
        continue;
      }
      if (line.startsWith("steps:")) {
        inSteps = true;
        continue;
      }
      continue;
    }

    // Inside steps array
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // New step (starts with "- id:")
    if (trimmed.startsWith("- id:")) {
      // Save previous step
      if (currentStep?.id) {
        if (inSubSteps && subSteps.length > 0) {
          (currentStep as any)[inSubSteps] = [...subSteps];
        }
        steps.push(currentStep as FlowStep);
      }
      currentStep = { id: trimmed.slice(5).trim().replace(/^(["'])(.+)\1$/, "$2") };
      inSubSteps = null;
      subSteps = [];
      continue;
    }

    // Sub-step in on_violation/on_failure (starts with "- agent:")
    if (inSubSteps && trimmed.startsWith("- agent:")) {
      const subStep: Partial<FlowStep> = {
        id: `${currentStep?.id}_${inSubSteps}_${subSteps.length}`,
        agent: trimmed.slice(8).trim().replace(/^(["'])(.+)\1$/, "$2"),
      };
      subSteps.push(subStep as FlowStep);
      continue;
    }

    // Sub-step property
    if (inSubSteps && indent >= 8 && subSteps.length > 0) {
      const lastSub = subSteps[subSteps.length - 1];
      parseStepField(trimmed, lastSub as any);
      continue;
    }

    // on_violation: or on_failure: markers
    if (trimmed === "on_violation:" || trimmed.startsWith("on_violation:")) {
      if (inSubSteps && subSteps.length > 0 && currentStep) {
        (currentStep as any)[inSubSteps] = [...subSteps];
      }
      inSubSteps = "on_violation";
      subSteps = [];
      continue;
    }
    if (trimmed === "on_failure:" || trimmed.startsWith("on_failure:")) {
      if (inSubSteps && subSteps.length > 0 && currentStep) {
        (currentStep as any)[inSubSteps] = [...subSteps];
      }
      inSubSteps = "on_failure";
      subSteps = [];
      continue;
    }

    // Step properties
    if (currentStep && indent >= 4 && !inSubSteps) {
      parseStepField(trimmed, currentStep);
      continue;
    }
    if (currentStep && indent >= 4 && inSubSteps && !trimmed.startsWith("-")) {
      // Could be a property of the last sub-step
      if (subSteps.length > 0) {
        parseStepField(trimmed, subSteps[subSteps.length - 1] as any);
      }
      continue;
    }
  }

  // Save last step
  if (currentStep?.id) {
    if (inSubSteps && subSteps.length > 0) {
      (currentStep as any)[inSubSteps] = [...subSteps];
    }
    steps.push(currentStep as FlowStep);
  }

  return {
    name,
    description,
    ...(maxIterations !== undefined ? { max_iterations: maxIterations } : {}),
    steps,
  };
}

function parseStepField(trimmed: string, step: Partial<FlowStep>): void {
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx === -1) return;

  const key = trimmed.slice(0, colonIdx).trim();
  let value = trimmed.slice(colonIdx + 1).trim();
  // Only strip wrapping quotes if the value is fully quoted
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  switch (key) {
    case "agent":
      step.agent = value;
      break;
    case "command":
      step.command = value;
      break;
    case "input":
      step.input = value;
      break;
    case "parallel_per":
      step.parallel_per = value;
      break;
    case "loop_until":
      step.loop_until = value;
      break;
    case "goto":
      step.goto = value;
      break;
    case "max_iterations":
      step.max_iterations = parseInt(value, 10);
      break;
    case "passthrough_flags":
      step.passthrough_flags = value === "true";
      break;
    case "wave":
      step.wave = value === "true";
      break;
    case "parallel":
      // Parse inline array: [a, b, c]
      if (value.startsWith("[")) {
        step.parallel = value
          .replace(/[\[\]]/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      break;
  }
}

/**
 * Validate a flow definition for structural correctness.
 */
export function validateFlow(flow: FlowDefinition): FlowValidationResult {
  const errors: FlowValidationError[] = [];
  const warnings: string[] = [];
  const stepIds = new Set<string>();

  if (!flow.name) {
    errors.push({ field: "name", message: "Flow must have a name" });
  }

  if (!flow.steps || flow.steps.length === 0) {
    errors.push({ field: "steps", message: "Flow must have at least one step" });
    return { valid: false, errors, warnings };
  }

  for (const step of flow.steps) {
    if (!step.id) {
      errors.push({ field: "steps", message: "Every step must have an id" });
      continue;
    }

    if (stepIds.has(step.id)) {
      errors.push({
        step_id: step.id,
        field: "id",
        message: `Duplicate step id: ${step.id}`,
      });
    }
    stepIds.add(step.id);

    if (!step.agent && !step.command) {
      errors.push({
        step_id: step.id,
        field: "agent|command",
        message: "Step must have either an agent or command",
      });
    }

    if (step.goto && !flow.steps.some((s) => s.id === step.goto)) {
      errors.push({
        step_id: step.id,
        field: "goto",
        message: `goto references unknown step: ${step.goto}`,
      });
    }

    if (step.loop_until && !step.max_iterations) {
      warnings.push(
        `Step "${step.id}" has loop_until but no max_iterations — will use flow default or 3`
      );
    }
  }

  // Detect simple cycles: goto pointing to a step that gotos back
  for (const step of flow.steps) {
    if (step.goto) {
      const target = flow.steps.find((s) => s.id === step.goto);
      if (target?.goto === step.id) {
        errors.push({
          step_id: step.id,
          field: "goto",
          message: `Cycle detected: ${step.id} ↔ ${target.id}`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Load all flow definitions from the flows directory.
 */
export async function loadFlows(
  projectDir: string,
  pluginDir: string
): Promise<FlowDefinition[]> {
  const flows: FlowDefinition[] = [];
  const seen = new Set<string>();

  // Project flows take precedence
  for (const dir of [
    join(projectDir, ".canon", "flows"),
    join(pluginDir, "flows"),
  ]) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const name = basename(file).replace(/\.(yaml|yml)$/, "");
      if (seen.has(name)) continue; // project overrides plugin
      seen.add(name);

      try {
        const content = await readFile(join(dir, file), "utf-8");
        const flow = parseFlowYaml(content);
        if (flow.name || name) {
          flow.name = flow.name || name;
          flows.push(flow);
        }
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
    }
  }

  return flows;
}

/**
 * Load a single flow by name.
 */
export async function loadFlow(
  name: string,
  projectDir: string,
  pluginDir: string
): Promise<FlowDefinition | null> {
  // Check project dir first, then plugin dir
  for (const dir of [
    join(projectDir, ".canon", "flows"),
    join(pluginDir, "flows"),
  ]) {
    for (const ext of [".yaml", ".yml"]) {
      try {
        const content = await readFile(join(dir, name + ext), "utf-8");
        const flow = parseFlowYaml(content);
        flow.name = flow.name || name;
        return flow;
      } catch {
        continue;
      }
    }
  }
  return null;
}
