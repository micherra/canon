import { substituteVariables, buildTemplateInjection } from "../orchestration/variables.js";
import { loadAllOverlays, filterOverlaysForAgent, buildOverlayInjection, type OverlayDefinition } from "../orchestration/overlays.js";
import { buildBulletinInstructions } from "../orchestration/bulletin.js";
import type { ResolvedFlow, StateDefinition } from "../orchestration/flow-schema.js";
import { evaluateSkipWhen } from "../orchestration/skip-when.js";
import { readBoard } from "../orchestration/board.js";
import { resolveContextInjections } from "../orchestration/inject-context.js";
import { clusterDiff, type FileCluster } from "../orchestration/diff-cluster.js";

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
  clusters?: FileCluster[];
  timeout_ms?: number;
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

  // Parse timeout override
  let timeout_ms: number | undefined;
  if (state.timeout) {
    timeout_ms = parseTimeout(state.timeout);
    if (timeout_ms === undefined) {
      warnings.push(`Invalid timeout format "${state.timeout}" — expected e.g. "10m", "1h", "90s"`);
    }
  }

  // Evaluate large_diff_threshold — cluster files when diff exceeds threshold
  let clusters: FileCluster[] | undefined;
  if (state.large_diff_threshold != null) {
    const board = state.skip_when ? undefined : await readBoard(input.workspace);
    const baseCommit = board?.base_commit ?? (await readBoard(input.workspace)).base_commit;
    const strategy = state.cluster_by ?? "directory";
    const result = clusterDiff(baseCommit, state.large_diff_threshold, strategy);
    if (result) {
      clusters = result;
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
      // When clusters are available, use cluster items instead of the original items
      if (clusters) {
        for (const cluster of clusters) {
          const clusterItem: TaskItem = {
            cluster_key: cluster.key,
            files: cluster.files.join(", "),
            file_count: cluster.files.length,
          };
          const prompt = substituteItem(basePrompt, clusterItem);
          prompts.push({ agent, prompt, item: clusterItem, template_paths: paths });
        }
      } else {
        const perItems = items ?? [];
        for (const item of perItems) {
          const prompt = substituteItem(basePrompt, item);
          prompts.push({ agent, prompt, item, template_paths: paths });
        }
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
    const bulletinInstr = buildBulletinInstructions(input.wave, peerCount, input.workspace);
    for (const entry of prompts) {
      entry.prompt += `\n\n${bulletinInstr}`;
    }
  }

  return {
    prompts,
    state_type: state.type,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(clusters ? { clusters } : {}),
    ...(timeout_ms != null ? { timeout_ms } : {}),
  };
}

/**
 * Parse a human-readable timeout string into milliseconds.
 * Supports: "30s", "10m", "1h", "1h30m".
 */
export function parseTimeout(timeout: string): number | undefined {
  let totalMs = 0;
  let matched = false;
  const remaining = timeout.replace(/(\d+)\s*(h|m|s)/gi, (_, num, unit) => {
    matched = true;
    const n = parseInt(num, 10);
    switch (unit.toLowerCase()) {
      case "h": totalMs += n * 3600000; break;
      case "m": totalMs += n * 60000; break;
      case "s": totalMs += n * 1000; break;
    }
    return "";
  });
  if (!matched || remaining.trim()) return undefined;
  return totalMs;
}
