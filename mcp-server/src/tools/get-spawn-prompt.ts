import { type CompeteConfig as ExpandedCompeteConfig, expandCompetitorPrompts } from "../orchestration/compete.ts";
import { buildDebatePrompt, debateTeamLabel, inspectDebateProgress } from "../orchestration/debate.ts";
import { clusterDiff, type FileCluster } from "../orchestration/diff-cluster.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { CompeteConfig, ResolvedFlow, StateDefinition } from "../orchestration/flow-schema.ts";
import { resolveContextInjections } from "../orchestration/inject-context.ts";
import { buildMessageInstructions } from "../orchestration/messages.ts";
import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import { buildTemplateInjection, substituteVariables } from "../orchestration/variables.ts";
import { assembleWaveBriefing, readWaveGuidance } from "../orchestration/wave-briefing.ts";

/** A task item passed to wave/parallel-per states — either a name or a structured plan. */
export type TaskItem = string | Record<string, string | number | boolean | string[]>;

interface SpawnPromptInput {
  workspace: string;
  state_id: string;
  flow: ResolvedFlow;
  variables: Record<string, string>;
  items?: TaskItem[];
  role?: string;
  project_dir?: string;
  wave?: number;
  peer_count?: number;
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
  isolation?: "worktree";
  worktree_path?: string;
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
function templatePaths(template: string | string[] | undefined, pluginDir: string): string[] {
  if (!template) return [];
  const names = Array.isArray(template) ? template : [template];
  return names.map((name) => `${pluginDir}/templates/${name}.md`);
}

function resolveCompeteConfig(config: CompeteConfig | undefined): ExpandedCompeteConfig | undefined {
  if (!config) return undefined;
  if (config === "auto") {
    return { count: 3, strategy: "synthesize" };
  }
  return config;
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

/** Resolve board, skip_when, inject_context, progress, and template into a base prompt. */
async function resolveBasePrompt(
  input: SpawnPromptInput,
  state: StateDefinition,
  state_id: string,
  flow: ResolvedFlow,
  variables: Record<string, string>,
): Promise<{
  basePrompt: string;
  mergedVariables: Record<string, string>;
  warnings: string[];
  board: import("../orchestration/flow-schema.ts").Board | undefined;
  skipResult?: SpawnPromptResult;
}> {
  const warnings: string[] = [];

  const needsBoard =
    !!state.skip_when ||
    (state.inject_context != null && state.inject_context.length > 0) ||
    state.large_diff_threshold != null;
  const board = input._board ?? (needsBoard ? (getExecutionStore(input.workspace).getBoard() ?? undefined) : undefined);

  if (state.skip_when) {
    const skipResult = await evaluateSkipWhen(state.skip_when, input.workspace, board!);
    if (skipResult.skip) {
      return {
        basePrompt: "",
        mergedVariables: variables,
        warnings,
        board,
        skipResult: {
          prompts: [],
          state_type: state.type,
          skip_reason: `Skipping ${state_id}: ${state.skip_when} condition met — ${skipResult.reason ?? "condition satisfied"}`,
        },
      };
    }
  }

  const rawInstruction = flow.spawn_instructions[state_id];
  if (!rawInstruction) {
    return {
      basePrompt: "",
      mergedVariables: variables,
      warnings,
      board,
      skipResult: { prompts: [], state_type: state.type, skip_reason: `No spawn instruction for state "${state_id}"` },
    };
  }

  let mergedVariables = { ...variables };

  if (state.inject_context && state.inject_context.length > 0) {
    const injectionResult = await resolveContextInjections(state.inject_context, board!, input.workspace);
    warnings.push(...injectionResult.warnings);
    if (injectionResult.hitl) {
      return {
        basePrompt: "",
        mergedVariables,
        warnings,
        board,
        skipResult: {
          prompts: [],
          state_type: state.type,
          skip_reason: `HITL required: inject_context from user — "${injectionResult.hitl.prompt}"`,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };
    }
    mergedVariables = { ...mergedVariables, ...injectionResult.variables };
  }

  if (input.flow.progress) {
    const store = getExecutionStore(input.workspace);
    const progressContent = store.getProgress(8);
    mergedVariables = { ...mergedVariables, progress: progressContent };
  }

  let basePrompt = substituteVariables(rawInstruction, mergedVariables);

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

  return { basePrompt, mergedVariables, warnings, board };
}

/** Build prompts for a debate state. Returns null if debate is completed. */
async function buildDebatePrompts(
  input: SpawnPromptInput,
  debateConfig: NonNullable<ResolvedFlow["debate"]>,
  basePrompt: string,
  paths: string[],
  warnings: string[],
  timeout_ms: number | undefined,
): Promise<SpawnPromptResult | null> {
  const debate = await inspectDebateProgress(input.workspace, debateConfig);

  if (!debate.completed) {
    const prompts: SpawnPromptEntry[] = [];
    const teamLabels = Array.from({ length: debateConfig.teams }, (_, i) => debateTeamLabel(i));
    for (const teamLabel of teamLabels) {
      const otherTeamLabels = teamLabels.filter((label) => label !== teamLabel);
      for (const agent of debateConfig.composition) {
        prompts.push({
          agent,
          role: teamLabel,
          item: { team: teamLabel, round: debate.next_round, channel: debate.next_channel },
          template_paths: paths,
          prompt: buildDebatePrompt(
            basePrompt,
            input.workspace,
            debate.next_round,
            debateConfig.max_rounds,
            teamLabel,
            otherTeamLabels,
            agent,
            debate.transcript,
          ),
        });
      }
    }

    return {
      prompts,
      state_type: "single",
      ...(warnings.length > 0 ? { warnings } : {}),
      timeout_ms,
      fanned_out: true,
    };
  }

  // Debate completed — return null so caller appends summary and continues
  if (debate.summary) {
    // Mutate basePrompt in caller via return value
    warnings.push(
      `Debate completed after round ${debate.last_completed_round}${
        debate.convergence?.reason ? `: ${debate.convergence.reason}` : ""
      }`,
    );
  }
  return null;
}

/** Build prompts for a "single" state type. */
function buildSinglePrompts(
  state: StateDefinition,
  basePrompt: string,
  paths: string[],
  clusters: FileCluster[] | undefined,
  competeConfig: ExpandedCompeteConfig | undefined,
): SpawnPromptEntry[] {
  const agent = state.agent ?? "unknown";
  if (clusters && clusters.length > 0) {
    return clusters.map((cluster) => {
      const clusterItem: TaskItem = {
        cluster_key: cluster.key,
        files: cluster.files.join(", "),
        file_count: cluster.files.length,
      };
      return { agent, prompt: substituteItem(basePrompt, clusterItem), item: clusterItem, template_paths: paths };
    });
  }
  if (competeConfig) {
    return expandCompetitorPrompts({ agent, prompt: basePrompt, template_paths: paths }, competeConfig).map(
      (entry) => ({ agent: entry.agent, prompt: entry.prompt, template_paths: entry.template_paths }),
    );
  }
  return [{ agent, prompt: basePrompt, template_paths: paths }];
}

/** Build prompts for a "parallel" state type. */
function buildParallelPrompts(state: StateDefinition, basePrompt: string, paths: string[]): SpawnPromptEntry[] {
  const agents = state.agents ?? [];
  const roles = state.roles ?? [];
  if (agents.length === 1 && roles.length > 1) {
    const agent = agents[0];
    return roles.map((roleEntry) => {
      const rName = roleName(roleEntry);
      return { agent, prompt: substituteVariables(basePrompt, { role: rName }), role: rName, template_paths: paths };
    });
  }
  return agents.map((agent) => ({ agent, prompt: basePrompt, template_paths: paths }));
}

/** Build prompts for "wave" or "parallel-per" state types. */
function buildPerItemPrompts(
  state: StateDefinition,
  basePrompt: string,
  paths: string[],
  items: TaskItem[] | undefined,
  clusters: FileCluster[] | undefined,
): SpawnPromptEntry[] {
  const agent = state.agent ?? "unknown";
  const perItems = clusters
    ? clusters.map((c): TaskItem => ({ cluster_key: c.key, files: c.files.join(", "), file_count: c.files.length }))
    : (items ?? []);
  return perItems.map((item) => ({
    agent,
    prompt: substituteItem(basePrompt, item),
    item,
    template_paths: paths,
    isolation: "worktree" as const,
  }));
}

/** Build prompts based on state type (single, parallel, wave, parallel-per). */
function buildStateTypePrompts(
  state: StateDefinition,
  basePrompt: string,
  paths: string[],
  items: TaskItem[] | undefined,
  clusters: FileCluster[] | undefined,
  competeConfig: ExpandedCompeteConfig | undefined,
): SpawnPromptEntry[] {
  switch (state.type) {
    case "single":
      return buildSinglePrompts(state, basePrompt, paths, clusters, competeConfig);
    case "parallel":
      return buildParallelPrompts(state, basePrompt, paths);
    case "wave":
    case "parallel-per":
      return buildPerItemPrompts(state, basePrompt, paths, items, clusters);
    default:
      return [];
  }
}

/** Inject wave-related context (messaging, guidance, briefing) into prompts. */
async function injectWaveContext(
  prompts: SpawnPromptEntry[],
  input: SpawnPromptInput,
  state: StateDefinition,
): Promise<void> {
  const isWaveType = state.type === "wave" || state.type === "parallel-per";
  if (!isWaveType || input.wave == null) return;

  const peerCount = input.peer_count ?? prompts.length - 1;
  const channel = `wave-${String(input.wave).padStart(3, "0")}`;
  const messageInstr = buildMessageInstructions(channel, peerCount, input.workspace);
  for (const entry of prompts) entry.prompt += `\n\n${messageInstr}`;

  const guidance = await readWaveGuidance(input.workspace);
  if (guidance) {
    for (const entry of prompts) entry.prompt += `\n\n## Wave Guidance (from user)\n\n${guidance}`;
  }

  if (input.consultation_outputs) {
    const briefing = assembleWaveBriefing({
      wave: input.wave,
      summaries: [],
      consultationOutputs: input.consultation_outputs,
    });
    if (briefing) {
      for (const entry of prompts) entry.prompt += `\n\n${briefing}`;
    }
  }
}

/** Parse timeout and evaluate diff clusters. */
function resolveTimeoutAndClusters(
  state: StateDefinition,
  board: import("../orchestration/flow-schema.ts").Board | undefined,
  warnings: string[],
): { timeout_ms?: number; clusters?: FileCluster[] } {
  let timeout_ms: number | undefined;
  if (state.timeout) {
    timeout_ms = parseTimeout(state.timeout);
    if (timeout_ms === undefined) {
      warnings.push(`Invalid timeout format "${state.timeout}" — expected e.g. "10m", "1h", "90s"`);
    }
  }

  let clusters: FileCluster[] | undefined;
  if (state.large_diff_threshold != null) {
    const baseCommit = board?.base_commit ?? "";
    const strategy = state.cluster_by ?? "directory";
    const result = clusterDiff(baseCommit, state.large_diff_threshold, strategy);
    if (result) clusters = result;
  }

  return { timeout_ms, clusters };
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

  const resolved = await resolveBasePrompt(input, state, state_id, flow, variables);
  if (resolved.skipResult) return resolved.skipResult;

  let { basePrompt } = resolved;
  const { mergedVariables, warnings, board } = resolved;
  const { timeout_ms, clusters } = resolveTimeoutAndClusters(state, board, warnings);

  const pluginDir = mergedVariables.CANON_PLUGIN_ROOT ?? "";
  const paths = pluginDir ? templatePaths(state.template, pluginDir) : [];
  const competeConfig = state.type === "single" ? resolveCompeteConfig(state.compete) : undefined;
  const debateConfig = state_id === flow.entry ? flow.debate : undefined;

  if (state.type !== "single" && state.compete) {
    warnings.push(`State "${state_id}" declares compete but only single states support prompt expansion`);
  }

  if (debateConfig) {
    const debateResult = await buildDebatePrompts(input, debateConfig, basePrompt, paths, warnings, timeout_ms);
    if (debateResult) return debateResult;
    const debate = await inspectDebateProgress(input.workspace, debateConfig);
    if (debate.summary) basePrompt += `\n\n${debate.summary}`;
  }

  const prompts = buildStateTypePrompts(state, basePrompt, paths, items, clusters, competeConfig);

  if (input.role && state.type === "single") {
    for (const p of prompts) {
      p.prompt = substituteVariables(p.prompt, { role: input.role });
      p.role = input.role;
    }
  }

  await injectWaveContext(prompts, input, state);

  const fanned_out = state.type === "single" && prompts.length > 1;
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
      case "h":
        totalMs += n * 3600000;
        break;
      case "m":
        totalMs += n * 60000;
        break;
      case "s":
        totalMs += n * 1000;
        break;
    }
    return "";
  });
  if (!matched || remaining.trim()) return undefined;
  return totalMs;
}
