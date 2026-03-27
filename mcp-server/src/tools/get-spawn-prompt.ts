import { readFile } from "fs/promises";
import { substituteVariables, buildTemplateInjection } from "../orchestration/variables.ts";
import { loadAllOverlays, filterOverlaysForAgent, buildOverlayInjection, type OverlayDefinition } from "../orchestration/overlays.ts";
import { buildBulletinInstructions } from "../orchestration/bulletin.ts";
import { readWaveGuidance, assembleWaveBriefing } from "../orchestration/wave-briefing.ts";
import type { ResolvedFlow, StateDefinition } from "../orchestration/flow-schema.ts";
import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import { readBoard } from "../orchestration/board.ts";
import { resolveContextInjections } from "../orchestration/inject-context.ts";
import { clusterDiff, type FileCluster } from "../orchestration/diff-cluster.ts";

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
  /**
   * Completed consultation outputs to inject into the wave briefing.
   * When provided alongside `wave`, assembleWaveBriefing is called and the
   * result is appended to each wave/parallel-per prompt entry.
   * Must be pre-escaped by the caller (e.g. via escapeDollarBrace).
   */
  consultation_outputs?: Record<string, { section?: string; summary: string }>;
  /**
   * Pre-read board — if provided, skips the internal readBoard call.
   * Use this when the caller has already read the board (e.g., enterAndPrepareState)
   * to avoid a redundant round-trip.
   */
  _board?: import("../orchestration/flow-schema.ts").Board;
}

export interface SpawnPromptEntry {
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
  fanned_out?: boolean;
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

/**
 * Truncate progress.md content to at most maxEntries entry lines.
 * Header lines (lines before the first "- [" entry) are always preserved.
 * If entry count is within the cap, content is returned unchanged.
 */
export function truncateProgress(content: string, maxEntries: number): string {
  const lines = content.split("\n");

  // Find the index of the first entry line (starts with "- [")
  const firstEntryIndex = lines.findIndex((l) => l.startsWith("- ["));
  if (firstEntryIndex === -1) {
    // No entries found — return content unchanged
    return content;
  }

  const headerLines = lines.slice(0, firstEntryIndex);
  const entryAndTrailing = lines.slice(firstEntryIndex);

  // Separate actual entry lines from any trailing non-entry lines
  // Entry lines are those matching /^- \[/; trailing blank lines may follow
  const entryLines = entryAndTrailing.filter((l) => l.startsWith("- ["));
  const trailingLines = entryAndTrailing.filter((l) => !l.startsWith("- ["));

  if (entryLines.length <= maxEntries) {
    return content;
  }

  if (maxEntries <= 0) {
    return [...headerLines, ...trailingLines].join("\n");
  }

  const keptEntries = entryLines.slice(-maxEntries);
  return [...headerLines, ...keptEntries, ...trailingLines].join("\n");
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

  // Read board once if any board-dependent feature is active.
  // If a pre-read board is provided (e.g., from enterAndPrepareState), use it directly
  // to avoid a redundant readBoard call.
  const needsBoard =
    !!state.skip_when ||
    (state.inject_context != null && state.inject_context.length > 0) ||
    state.large_diff_threshold != null;
  const board = input._board ?? (needsBoard ? await readBoard(input.workspace) : undefined);

  // Evaluate skip_when condition before spawning
  if (state.skip_when) {
    const skipResult = await evaluateSkipWhen(state.skip_when, input.workspace, board!);
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
    const injectionResult = await resolveContextInjections(state.inject_context, board!, input.workspace);

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

  // Resolve progress.md if the flow declares a progress path
  if (input.flow.progress) {
    const progressPath = input.flow.progress.replace(
      /\$\{WORKSPACE\}/g,
      input.workspace
    );
    try {
      const rawProgress = await readFile(progressPath, "utf-8");
      const progressContent = truncateProgress(rawProgress, 8);
      mergedVariables = { ...mergedVariables, progress: progressContent };
    } catch {
      // progress.md may not exist yet -- degrade gracefully
      mergedVariables = { ...mergedVariables, progress: "" };
    }
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
    const baseCommit = board?.base_commit ?? "";
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
      if (clusters && clusters.length > 0) {
        // Fan out: one prompt per cluster, scoped to cluster files
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
        prompts.push({ agent, prompt: basePrompt, template_paths: paths });
      }
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

  // Inject wave guidance for wave states
  if ((state.type === "wave" || state.type === "parallel-per") && input.wave != null) {
    const guidance = await readWaveGuidance(input.workspace);
    if (guidance) {
      for (const entry of prompts) {
        entry.prompt += `\n\n## Wave Guidance (from user)\n\n${guidance}`;
      }
    }
  }

  // Inject wave briefing for wave/parallel-per states
  if ((state.type === "wave" || state.type === "parallel-per") && input.wave != null && input.consultation_outputs) {
    const briefing = assembleWaveBriefing({
      wave: input.wave,
      summaries: [],  // Summaries from prior agents — caller provides via separate mechanism
      consultationOutputs: input.consultation_outputs,
    });
    if (briefing) {
      for (const entry of prompts) {
        entry.prompt += `\n\n${briefing}`;
      }
    }
  }

  const fanned_out = state.type === "single" && clusters != null && clusters.length > 0;
  return {
    prompts,
    state_type: state.type,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(clusters ? { clusters } : {}),
    ...(timeout_ms != null ? { timeout_ms } : {}),
    ...(fanned_out ? { fanned_out: true } : {}),
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
