import { substituteVariables, buildTemplateInjection } from "../orchestration/variables.js";
import { loadAllOverlays, filterOverlaysForAgent, buildOverlayInjection, type OverlayDefinition } from "../orchestration/overlays.js";
import { buildBulletinInstructions } from "../orchestration/bulletin.js";
import type { ResolvedFlow, StateDefinition } from "../orchestration/flow-schema.js";
import { evaluateSkipWhen } from "../orchestration/skip-when.js";
import { readBoard } from "../orchestration/board.js";
import { resolveContextInjections } from "../orchestration/inject-context.js";

/** A task item passed to wave/parallel-per states — either a name or a structured plan. */
export type TaskItem = string | Record<string, string | number | boolean | string[]>;

interface SpawnPromptInput {
  workspace: string;
  state_id: string;
  flow: ResolvedFlow;
  variables: Record<string, string>;
  items?: TaskItem[];
  role?: string;
  overlays?: string[];
  project_dir?: string;
  wave?: number;
  peer_count?: number;
  loaded_overlays?: OverlayDefinition[];
}

interface SpawnPromptEntry {
  agent: string;
  prompt: string;
  role?: string;
  item?: TaskItem;
  template_paths: string[];
}

interface SpawnPromptResult {
  prompts: SpawnPromptEntry[];
  state_type: string;
  skip_reason?: string;
  warnings?: string[];
}

/**
 * Resolve the role name from a RoleEntry (string or { name, optional }).
 */
function roleName(entry: string | { name: string; optional?: boolean }): string {
  return typeof entry === "string" ? entry : entry.name;
}

/**
 * Compute template file paths from a state's template field.
 */
function templatePaths(
  template: string | string[] | undefined,
  pluginDir: string,
): string[] {
  if (!template) return [];
  const names = Array.isArray(template) ? template : [template];
  return names.map((name) => `${pluginDir}/templates/${name}.md`);
}

/**
 * Substitute ${item} and ${item.field} patterns in a prompt string.
 */
function substituteItem(prompt: string, item: TaskItem): string {
  const itemStr = typeof item === "string" ? item : JSON.stringify(item);
  let result = prompt.replace(/\$\{item\}/g, itemStr);

  // Handle ${item.field} patterns for object items
  if (typeof item === "object") {
    result = result.replace(/\$\{item\.([^}]+)\}/g, (match, field: string) => {
      if (field in item) {
        const val = item[field];
        return typeof val === "string" ? val : JSON.stringify(val);
      }
      return match;
    });
  }

  return result;
}

export async function getSpawnPrompt(input: SpawnPromptInput): Promise<SpawnPromptResult> {
  const { state_id, flow, variables, items } = input;

  const state: StateDefinition | undefined = flow.states[state_id];
  if (!state) {
    return { prompts: [], state_type: "unknown", skip_reason: `State "${state_id}" not found in flow` };
  }

  if (state.type === "terminal") {
    return { prompts: [], state_type: "terminal" };
  }

  // Evaluate skip_when condition before spawning
  if (state.skip_when) {
    const board = await readBoard(input.workspace);
    const skipResult = await evaluateSkipWhen(state.skip_when, input.workspace, board);
    if (skipResult.skip) {
      return {
        prompts: [],
        state_type: state.type,
        skip_reason: `Skipping ${state_id}: ${state.skip_when} condition met — ${skipResult.reason ?? "condition satisfied"}`,
      };
    }
  }

  const rawInstruction = flow.spawn_instructions[state_id];
  if (!rawInstruction) {
    return { prompts: [], state_type: state.type, skip_reason: `No spawn instruction for state "${state_id}"` };
  }

  // Resolve inject_context before variable substitution — merge into a copy, do not mutate input
  let mergedVariables = { ...variables };
  const warnings: string[] = [];

  if (state.inject_context && state.inject_context.length > 0) {
    const board = await readBoard(input.workspace);
    const injectionResult = await resolveContextInjections(state.inject_context, board, input.workspace);

    // Add injection warnings
    warnings.push(...injectionResult.warnings);

    // If HITL is needed (from: user), return skip with HITL reason
    if (injectionResult.hitl) {
      return {
        prompts: [],
        state_type: state.type,
        skip_reason: `HITL required: inject_context from user — "${injectionResult.hitl.prompt}"`,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    // Merge injection variables into the variables map for substitution
    mergedVariables = { ...mergedVariables, ...injectionResult.variables };
  }

  // Substitute flow-level variables (using merged variables that include injected context)
  let basePrompt = substituteVariables(rawInstruction, mergedVariables);

  // Build template injection if the state declares templates
  const pluginDir = mergedVariables.CANON_PLUGIN_ROOT ?? "";
  if (state.template) {
    if (!pluginDir) {
      warnings.push(
        `State "${state_id}" declares template but CANON_PLUGIN_ROOT is empty — skipping template injection`,
      );
    } else {
      const injection = buildTemplateInjection(state.template, pluginDir);
      basePrompt = `${basePrompt}\n\n${injection}`;
    }
  }

  // Warn about unimplemented fields that are present but not yet evaluated at runtime
  // large_diff_threshold, cluster_by, and timeout remain unimplemented at runtime.
  // gate and consultations are now implemented — they are no longer deferred.
  const deferredFields = ["large_diff_threshold", "cluster_by", "timeout"] as const;
  for (const field of deferredFields) {
    if (state[field] !== undefined) {
      warnings.push(`StateDefinition field "${field}" is present but not yet implemented at runtime`);
    }
  }

  const paths = pluginDir ? templatePaths(state.template, pluginDir) : [];
  const prompts: SpawnPromptEntry[] = [];

  switch (state.type) {
    case "single": {
      const agent = state.agent ?? "unknown";
      prompts.push({ agent, prompt: basePrompt, template_paths: paths });
      break;
    }

    case "parallel": {
      const agents = state.agents ?? [];
      const roles = state.roles ?? [];

      if (agents.length === 1 && roles.length > 1) {
        // One agent, multiple roles
        const agent = agents[0];
        for (const roleEntry of roles) {
          const rName = roleName(roleEntry);
          const prompt = substituteVariables(basePrompt, { role: rName });
          prompts.push({ agent, prompt, role: rName, template_paths: paths });
        }
      } else {
        // One prompt per agent
        for (const agent of agents) {
          prompts.push({ agent, prompt: basePrompt, template_paths: paths });
        }
      }
      break;
    }

    case "wave": {
      const agent = state.agent ?? "unknown";
      const waveItems = items ?? [];
      for (const item of waveItems) {
        const prompt = substituteItem(basePrompt, item);
        prompts.push({ agent, prompt, item, template_paths: paths });
      }
      break;
    }

    case "parallel-per": {
      const agent = state.agent ?? "unknown";
      const perItems = items ?? [];
      for (const item of perItems) {
        const prompt = substituteItem(basePrompt, item);
        prompts.push({ agent, prompt, item, template_paths: paths });
      }
      break;
    }
  }

  // Apply role substitution for single-role states
  if (input.role && state.type === "single") {
    for (let i = 0; i < prompts.length; i++) {
      prompts[i].prompt = substituteVariables(prompts[i].prompt, { role: input.role });
      prompts[i].role = input.role;
    }
  }

  // Inject role overlays if requested
  if (input.project_dir && (input.overlays?.length || state.overlays?.length)) {
    const allOverlays = input.loaded_overlays ?? await loadAllOverlays(input.project_dir);
    const requestedNames = new Set([
      ...(input.overlays ?? []),
      ...(state.overlays ?? []),
    ]);

    const requested = allOverlays.filter(o => requestedNames.has(o.name));

    for (const entry of prompts) {
      const applicable = filterOverlaysForAgent(requested, entry.agent);
      const injection = buildOverlayInjection(applicable);
      if (injection) {
        entry.prompt += injection;
      }
    }
  }

  // Inject bulletin coordination instructions for wave/parallel-per states
  if ((state.type === "wave" || state.type === "parallel-per") && input.wave != null) {
    const peerCount = input.peer_count ?? prompts.length - 1;
    const bulletinInstr = buildBulletinInstructions(input.wave, peerCount);
    for (const entry of prompts) {
      entry.prompt += `\n\n${bulletinInstr}`;
    }
  }

  return {
    prompts,
    state_type: state.type,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
