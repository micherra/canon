/**
 * Stage 7: fanout
 *
 * Expands a single base prompt into N fanned-out prompt entries based on
 * the state type.
 *
 * State type dispatch (all types get isolation: "worktree"; consultations remain "none"):
 * - single: clusters, compete, or single prompt — isolation: "worktree"
 * - parallel: agents-based or roles-based fanout — isolation: "worktree"
 * - wave: iterate items with ${item} substitution — isolation: "worktree"
 * - parallel-per: clusters or items — isolation: "worktree"
 *
 * Also handles debate detection (when flow.debate is set on the entry state):
 * - Active debate: produces per-team prompts and marks ctx.fanned_out = true
 * - Completed debate: appends summary to basePrompt and continues to normal fanout
 *
 * Behavioral invariants from the original code:
 * - `clusters && clusters.length > 0` guard: empty array falls through (null-vs-empty)
 * - `items ?? []`: undefined items produces zero prompts with no warning
 * - Debate early return sets fanned_out: true
 * - Compete config ignored (with warning) on non-single states
 *
 * Canon: functions-do-one-thing — this stage does one thing: expand basePrompt
 * into N prompt entries based on state type.
 */

import {
  type CompeteConfig as ExpandedCompeteConfig,
  expandCompetitorPrompts,
} from "../../orchestration/compete.ts";
import {
  buildDebatePrompt,
  debateTeamLabel,
  inspectDebateProgress,
} from "../../orchestration/debate.ts";
import { clusterDiff, type FileCluster } from "../../orchestration/diff-cluster.ts";
import type { CompeteConfig } from "../../orchestration/flow-schema.ts";
import { substituteVariables } from "../../orchestration/variables.ts";
import type { PromptContext, SpawnPromptEntry, TaskItem } from "./types.ts";

// Helpers (extracted from get-spawn-prompt.ts)

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

/**
 * Resolve the compete config to the expanded form.
 */
function resolveCompeteConfig(
  config: CompeteConfig | undefined,
): ExpandedCompeteConfig | undefined {
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
        const val = item[field as keyof typeof item];
        return typeof val === "string" ? val : JSON.stringify(val);
      }
      return match;
    });
  }

  return result;
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

// Stage implementation

/**
 * Stage 7: Expand ctx.basePrompt into ctx.prompts[] based on state type.
 */
/** Resolve timeout from state definition. */
function resolveTimeout(state: PromptContext["state"]): {
  timeout_ms: number | undefined;
  warning?: string;
} {
  if (!("timeout" in state) || !state.timeout) return { timeout_ms: undefined };
  const timeout_ms = parseTimeout(state.timeout as string);
  if (timeout_ms === undefined) {
    return {
      timeout_ms: undefined,
      warning: `Invalid timeout format "${state.timeout}" — expected e.g. "10m", "1h", "90s"`,
    };
  }
  return { timeout_ms };
}

/** Resolve diff clusters from state definition. */
function resolveClusters(
  state: PromptContext["state"],
  board: PromptContext["board"],
): FileCluster[] | undefined {
  if (!("large_diff_threshold" in state) || state.large_diff_threshold == null) return undefined;
  const baseCommit = board?.base_commit ?? "";
  const strategy =
    "cluster_by" in state && state.cluster_by
      ? (state.cluster_by as "directory" | "layer")
      : "directory";
  return clusterDiff(baseCommit, state.large_diff_threshold as number, strategy) ?? undefined;
}

/** Build prompts for an active (incomplete) debate. */
function buildActiveDebatePrompts(
  dc: Parameters<typeof inspectDebateProgress>[1],
  debate: Awaited<ReturnType<typeof inspectDebateProgress>>,
  opts: { basePrompt: string; workspace: string; paths: string[] },
): SpawnPromptEntry[] {
  const { basePrompt, workspace, paths } = opts;
  const prompts: SpawnPromptEntry[] = [];
  const teamLabels = Array.from({ length: dc.teams }, (_, i) => debateTeamLabel(i));
  for (const teamLabel of teamLabels) {
    const otherTeamLabels = teamLabels.filter((label) => label !== teamLabel);
    for (const agent of dc.composition) {
      prompts.push({
        agent,
        item: { channel: debate.next_channel, round: debate.next_round, team: teamLabel },
        prompt: buildDebatePrompt(basePrompt, {
          agent,
          maxRounds: dc.max_rounds,
          otherTeamLabels,
          roundNumber: debate.next_round,
          teamLabel,
          transcript: debate.transcript,
          workspace,
        }),
        role: teamLabel,
        template_paths: paths,
      });
    }
  }
  return prompts;
}

/** Build cluster-based prompt entries. */
function buildClusterPrompts(
  agent: string,
  basePrompt: string,
  clusters: FileCluster[],
  paths: string[],
): SpawnPromptEntry[] {
  return clusters.map((cluster) => {
    const clusterItem: TaskItem = {
      cluster_key: cluster.key,
      file_count: cluster.files.length,
      files: cluster.files.join(", "),
    };
    return {
      agent,
      isolation: "worktree" as const,
      item: clusterItem,
      prompt: substituteItem(basePrompt, clusterItem),
      template_paths: paths,
    };
  });
}

/** Build prompts for a single state type. */
function fanoutSingle(
  state: PromptContext["state"],
  basePrompt: string,
  paths: string[],
  clusters: FileCluster[] | undefined,
): SpawnPromptEntry[] {
  const agent = ("agent" in state ? state.agent : undefined) ?? "unknown";
  const competeConfig = resolveCompeteConfig(
    ("compete" in state ? state.compete : undefined) as CompeteConfig | undefined,
  );

  if (clusters && clusters.length > 0) {
    return buildClusterPrompts(agent, basePrompt, clusters, paths);
  }

  if (competeConfig) {
    const expanded = expandCompetitorPrompts(
      { agent, prompt: basePrompt, template_paths: paths },
      competeConfig,
    );
    return expanded.map((entry) => ({
      agent: entry.agent,
      isolation: "worktree" as const,
      prompt: entry.prompt,
      template_paths: entry.template_paths,
    }));
  }

  return [{ agent, isolation: "worktree" as const, prompt: basePrompt, template_paths: paths }];
}

/** Build prompts for a parallel state type. */
function fanoutParallel(
  state: PromptContext["state"],
  basePrompt: string,
  paths: string[],
): SpawnPromptEntry[] {
  const agents = ("agents" in state ? state.agents : undefined) ?? [];
  const roles = ("roles" in state ? state.roles : undefined) ?? [];

  if (agents.length === 1 && roles.length > 1) {
    const agent = agents[0];
    return roles.map((roleEntry) => {
      const rName = roleName(roleEntry as string | { name: string; optional?: boolean });
      return {
        agent,
        isolation: "worktree" as const,
        prompt: substituteVariables(basePrompt, { role: rName }),
        role: rName,
        template_paths: paths,
      };
    });
  }

  return agents.map((agent) => ({
    agent,
    isolation: "worktree" as const,
    prompt: basePrompt,
    template_paths: paths,
  }));
}

/** Build prompts for a wave state type. */
function fanoutWave(
  state: PromptContext["state"],
  basePrompt: string,
  paths: string[],
  items: TaskItem[] | undefined,
): SpawnPromptEntry[] {
  const agent = ("agent" in state ? state.agent : undefined) ?? "unknown";
  return (items ?? []).map((item) => ({
    agent,
    isolation: "worktree" as const,
    item,
    prompt: substituteItem(basePrompt, item),
    template_paths: paths,
  }));
}

/** Build prompts for a parallel-per state type. */
function fanoutParallelPer(
  state: PromptContext["state"],
  opts: {
    basePrompt: string;
    paths: string[];
    items: TaskItem[] | undefined;
    clusters: FileCluster[] | undefined;
  },
): SpawnPromptEntry[] {
  const { basePrompt, paths, items, clusters } = opts;
  const agent = ("agent" in state ? state.agent : undefined) ?? "unknown";
  if (clusters) {
    return buildClusterPrompts(agent, basePrompt, clusters, paths);
  }
  return (items ?? []).map((item) => ({
    agent,
    isolation: "worktree" as const,
    item,
    prompt: substituteItem(basePrompt, item),
    template_paths: paths,
  }));
}

/** Handle debate detection and return early context if debate is active, or mutated basePrompt/warnings if completed. */
async function handleDebate(
  state_id: string,
  flow: PromptContext["input"]["flow"],
  opts: {
    workspace: string;
    basePrompt: string;
    warnings: string[];
    paths: string[];
    ctx: PromptContext;
    clusters: ReturnType<typeof resolveClusters>;
    timeout_ms: number | undefined;
  },
): Promise<{ earlyReturn?: PromptContext; basePrompt: string; warnings: string[] }> {
  const { workspace, basePrompt, warnings, paths, ctx, clusters, timeout_ms } = opts;
  const debateConfig =
    state_id === flow.entry ? (flow as Record<string, unknown>).debate : undefined;
  if (!debateConfig) return { basePrompt, warnings };

  const dc = debateConfig as Parameters<typeof inspectDebateProgress>[1];
  const debate = await inspectDebateProgress(workspace, dc);

  if (!debate.completed) {
    const debatePrompts = buildActiveDebatePrompts(dc, debate, { basePrompt, paths, workspace });
    return {
      basePrompt,
      earlyReturn: {
        ...ctx,
        clusters,
        fanned_out: true,
        prompts: debatePrompts,
        timeout_ms,
        warnings,
      },
      warnings,
    };
  }

  const updatedPrompt = debate.summary ? `${basePrompt}\n\n${debate.summary}` : basePrompt;
  const convergenceDetail = debate.convergence?.reason ? `: ${debate.convergence.reason}` : "";
  const updatedWarnings = [
    ...warnings,
    `Debate completed after round ${debate.last_completed_round}${convergenceDetail}`,
  ];
  return { basePrompt: updatedPrompt, warnings: updatedWarnings };
}

/** Dispatch to the appropriate fanout function based on state type. */
function dispatchFanout(
  state: PromptContext["state"],
  opts: {
    basePrompt: string;
    paths: string[];
    items: PromptContext["input"]["items"];
    clusters: ReturnType<typeof resolveClusters>;
  },
): SpawnPromptEntry[] {
  const { basePrompt, paths, items, clusters } = opts;
  switch (state.type) {
    case "single":
      return fanoutSingle(state, basePrompt, paths, clusters);
    case "parallel":
      return fanoutParallel(state, basePrompt, paths);
    case "wave":
      return fanoutWave(state, basePrompt, paths, items);
    case "parallel-per":
      return fanoutParallelPer(state, { basePrompt, clusters, items, paths });
    default:
      return [];
  }
}

export async function fanout(ctx: PromptContext): Promise<PromptContext> {
  const { state } = ctx;
  const { state_id, flow, variables, items, workspace } = ctx.input;
  let { basePrompt, warnings } = ctx;

  const { timeout_ms, warning: timeoutWarning } = resolveTimeout(state);
  if (timeoutWarning) warnings = [...warnings, timeoutWarning];

  const clusters = resolveClusters(state, ctx.board);

  const pluginDir = ctx.mergedVariables.CANON_PLUGIN_ROOT ?? variables.CANON_PLUGIN_ROOT ?? "";
  const paths = pluginDir
    ? templatePaths(
        ("template" in state ? state.template : undefined) as string | string[] | undefined,
        pluginDir,
      )
    : [];

  if (state.type !== "single" && "compete" in state && state.compete) {
    warnings = [
      ...warnings,
      `State "${state_id}" declares compete but only single states support prompt expansion`,
    ];
  }

  const debateResult = await handleDebate(state_id, flow, {
    basePrompt,
    clusters,
    ctx,
    paths,
    timeout_ms,
    warnings,
    workspace,
  });
  if (debateResult.earlyReturn) return debateResult.earlyReturn;
  basePrompt = debateResult.basePrompt;
  warnings = debateResult.warnings;

  const prompts = dispatchFanout(state, { basePrompt, clusters, items, paths });
  const fanned_out = state.type === "single" && prompts.length > 1;
  return {
    ...ctx,
    basePrompt,
    clusters,
    prompts,
    timeout_ms,
    warnings,
    ...(fanned_out ? { fanned_out: true } : {}),
  };
}
