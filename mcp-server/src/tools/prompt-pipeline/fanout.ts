/**
 * Stage 8: fanout
 *
 * Expands a single base prompt into N fanned-out prompt entries based on
 * the state type.
 *
 * State type dispatch:
 * - single: clusters, compete, or single prompt
 * - parallel: agents-based or roles-based fanout
 * - wave: iterate items with ${item} substitution, isolation: "worktree"
 * - parallel-per: clusters or items with isolation: "worktree"
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

import { substituteVariables } from "../../orchestration/variables.ts";
import { expandCompetitorPrompts, type CompeteConfig as ExpandedCompeteConfig } from "../../orchestration/compete.ts";
import { clusterDiff, type FileCluster } from "../../orchestration/diff-cluster.ts";
import { inspectDebateProgress, buildDebatePrompt, debateTeamLabel } from "../../orchestration/debate.ts";
import type { CompeteConfig } from "../../orchestration/flow-schema.ts";
import type { PromptContext, SpawnPromptEntry, TaskItem } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers (extracted from get-spawn-prompt.ts)
// ---------------------------------------------------------------------------

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
 * Resolve the compete config to the expanded form.
 */
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
      case "h": totalMs += n * 3600000; break;
      case "m": totalMs += n * 60000; break;
      case "s": totalMs += n * 1000; break;
    }
    return "";
  });
  if (!matched || remaining.trim()) return undefined;
  return totalMs;
}

// ---------------------------------------------------------------------------
// Stage implementation
// ---------------------------------------------------------------------------

/**
 * Stage 8: Expand ctx.basePrompt into ctx.prompts[] based on state type.
 */
export async function fanout(ctx: PromptContext): Promise<PromptContext> {
  const { state } = ctx;
  const { state_id, flow, variables, items, workspace } = ctx.input;
  let { basePrompt, warnings } = ctx;
  let timeout_ms: number | undefined;
  let clusters: FileCluster[] | undefined;

  // Parse timeout override
  if ("timeout" in state && state.timeout) {
    timeout_ms = parseTimeout(state.timeout as string);
    if (timeout_ms === undefined) {
      warnings = [...warnings, `Invalid timeout format "${state.timeout}" — expected e.g. "10m", "1h", "90s"`];
    }
  }

  // Evaluate large_diff_threshold — cluster files when diff exceeds threshold
  if ("large_diff_threshold" in state && state.large_diff_threshold != null) {
    const baseCommit = ctx.board?.base_commit ?? "";
    const strategy = ("cluster_by" in state && state.cluster_by) ? state.cluster_by as "directory" | "layer" : "directory";
    const result = clusterDiff(baseCommit, state.large_diff_threshold as number, strategy);
    if (result) {
      clusters = result;
    }
  }

  const pluginDir = ctx.mergedVariables.CANON_PLUGIN_ROOT ?? variables.CANON_PLUGIN_ROOT ?? "";
  const paths = pluginDir ? templatePaths(("template" in state ? state.template : undefined) as string | string[] | undefined, pluginDir) : [];
  const prompts: SpawnPromptEntry[] = [];

  // Warn about compete on non-single states
  if (state.type !== "single" && "compete" in state && state.compete) {
    warnings = [
      ...warnings,
      `State "${state_id}" declares compete but only single states support prompt expansion`,
    ];
  }

  // Handle debate if flow.debate is configured and this is the entry state
  const debateConfig = state_id === flow.entry ? (flow as Record<string, unknown>).debate : undefined;
  if (debateConfig) {
    const debate = await inspectDebateProgress(workspace, debateConfig as Parameters<typeof inspectDebateProgress>[1]);

    if (!debate.completed) {
      const dc = debateConfig as Parameters<typeof inspectDebateProgress>[1];
      const teamLabels = Array.from({ length: dc.teams }, (_, i) => debateTeamLabel(i));
      for (const teamLabel of teamLabels) {
        const otherTeamLabels = teamLabels.filter((label) => label !== teamLabel);
        for (const agent of dc.composition) {
          prompts.push({
            agent,
            role: teamLabel,
            item: { team: teamLabel, round: debate.next_round, channel: debate.next_channel },
            template_paths: paths,
            prompt: buildDebatePrompt(
              basePrompt,
              workspace,
              debate.next_round,
              dc.max_rounds,
              teamLabel,
              otherTeamLabels,
              agent,
              debate.transcript,
            ),
          });
        }
      }

      return {
        ...ctx,
        prompts,
        warnings,
        clusters,
        timeout_ms,
        fanned_out: true,
      };
    }

    if (debate.summary) {
      basePrompt += `\n\n${debate.summary}`;
    }
    warnings = [
      ...warnings,
      `Debate completed after round ${debate.last_completed_round}${
        debate.convergence?.reason ? `: ${debate.convergence.reason}` : ""
      }`,
    ];
  }

  // State-type switch: produce prompts[]
  switch (state.type) {
    case "single": {
      const agent = ("agent" in state ? state.agent : undefined) ?? "unknown";
      const competeConfig = resolveCompeteConfig(("compete" in state ? state.compete : undefined) as CompeteConfig | undefined);

      if (clusters && clusters.length > 0) {
        // Fan out: one prompt per cluster, scoped to cluster files
        for (const cluster of clusters) {
          const clusterItem: TaskItem = {
            cluster_key: cluster.key,
            files: cluster.files.join(", "),
            file_count: cluster.files.length,
          };
          const prompt = substituteItem(basePrompt, clusterItem);
          prompts.push({ agent, prompt, item: clusterItem, template_paths: paths, isolation: "worktree" });
        }
      } else if (competeConfig) {
        const expanded = expandCompetitorPrompts(
          { agent, prompt: basePrompt, template_paths: paths },
          competeConfig,
        );
        for (const entry of expanded) {
          prompts.push({
            agent: entry.agent,
            prompt: entry.prompt,
            template_paths: entry.template_paths,
            isolation: "worktree",
          });
        }
      } else {
        prompts.push({ agent, prompt: basePrompt, template_paths: paths, isolation: "worktree" });
      }
      break;
    }

    case "parallel": {
      const agents = ("agents" in state ? state.agents : undefined) ?? [];
      const roles = ("roles" in state ? state.roles : undefined) ?? [];

      if (agents.length === 1 && roles.length > 1) {
        // One agent, multiple roles
        const agent = agents[0];
        for (const roleEntry of roles) {
          const rName = roleName(roleEntry as string | { name: string; optional?: boolean });
          const prompt = substituteVariables(basePrompt, { role: rName });
          prompts.push({ agent, prompt, role: rName, template_paths: paths, isolation: "worktree" });
        }
      } else {
        // One prompt per agent
        for (const agent of agents) {
          prompts.push({ agent, prompt: basePrompt, template_paths: paths, isolation: "worktree" });
        }
      }
      break;
    }

    case "wave": {
      const agent = ("agent" in state ? state.agent : undefined) ?? "unknown";
      const waveItems = items ?? [];
      for (const item of waveItems) {
        const prompt = substituteItem(basePrompt, item);
        prompts.push({ agent, prompt, item, template_paths: paths, isolation: "worktree" });
      }
      break;
    }

    case "parallel-per": {
      const agent = ("agent" in state ? state.agent : undefined) ?? "unknown";
      // When clusters are available, use cluster items instead of the original items
      if (clusters) {
        for (const cluster of clusters) {
          const clusterItem: TaskItem = {
            cluster_key: cluster.key,
            files: cluster.files.join(", "),
            file_count: cluster.files.length,
          };
          const prompt = substituteItem(basePrompt, clusterItem);
          prompts.push({ agent, prompt, item: clusterItem, template_paths: paths, isolation: "worktree" });
        }
      } else {
        const perItems = items ?? [];
        for (const item of perItems) {
          const prompt = substituteItem(basePrompt, item);
          prompts.push({ agent, prompt, item, template_paths: paths, isolation: "worktree" });
        }
      }
      break;
    }
  }

  const fanned_out = state.type === "single" && prompts.length > 1;
  return {
    ...ctx,
    basePrompt,
    prompts,
    warnings,
    clusters,
    timeout_ms,
    ...(fanned_out ? { fanned_out: true } : {}),
  };
}
