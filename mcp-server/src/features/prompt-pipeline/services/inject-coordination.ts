/**
 * Stage 8: inject-coordination
 *
 * Applies three types of coordination injection to fanned-out prompts:
 *
 * 1. **Role substitution** (single states only): when ctx.role is set,
 *    substitutes `${role}` in all prompt entries and sets entry.role.
 *
 * 2. **Metrics footer** (all prompts, unconditional): appends the
 *    record_agent_metrics instruction with concrete workspace and state_id
 *    values. Every prompt entry receives this footer regardless of state type.
 *
 * 3. **Tool scope metadata** (ADR-014, all prompts, unconditional): resolves
 *    and sets `tools`, `disallowed_tools`, and `permission_mode` on every
 *    prompt entry based on the agent type, optional per-state tool_overrides,
 *    and whether the entry has a worktree_path (the sole permission mode signal).
 *    Permission mode is informed by the KG trust resolver when available.
 *
 * Note: Wave coordination messaging (post_message/get_messages for peer agents)
 * was removed from Stage 8. Debate/compete flows build their own prompts via
 * buildDebatePrompt in debate.ts. Wave events from the orchestrator are still
 * received by agents via get_messages(include_events: true).
 *
 * Canon: functions-do-one-thing — four related but distinct injection
 * operations, all concerning coordination and observability metadata.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { ToolOverrides } from "@domains/flows/flow-definition-schemas.ts";
import { substituteVariables } from "@domains/messages/variables.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { resolveTaskScope } from "@features/orchestration/services/scope-resolver.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { computeFileInsightMaps } from "@graph/kg-query-insights.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { formatCommitTrailers } from "@shared/lib/commit-trailers.ts";
import { AGENT_TOOL_PROFILES, EMPTY_PROFILE, resolveToolProfile } from "../model/tool-profiles.ts";
import type { PromptContext, SpawnPromptEntry, TaskItem } from "../model/types.ts";
import {
  buildScopeMetrics,
  computeTrustLevel,
  trustLevelToPermissionMode,
} from "./trust-resolver.ts";

/**
 * Check whether an agent has write capability (Edit or Write in base profile).
 */
function agentHasWriteCapability(agent: string): boolean {
  const normalizedAgent = agent.startsWith("canon:") ? agent.slice("canon:".length) : agent;
  const profile = AGENT_TOOL_PROFILES[normalizedAgent] ?? EMPTY_PROFILE;
  return profile.allowed.includes("Edit") || profile.allowed.includes("Write");
}

/**
 * Close a KG database handle, ignoring errors.
 */
function closeDb(db: ReturnType<typeof initDatabase> | undefined): void {
  if (db !== undefined) {
    try {
      db.close();
    } catch {
      /* ignore close errors */
    }
  }
}

/**
 * Lazily load the board from the execution store.
 * Returns null if the workspace has no execution store or the store has no board.
 */
function lazyLoadBoard(workspace: string): Board | null {
  try {
    return getExecutionStore(workspace).getBoard();
  } catch {
    return null;
  }
}

/**
 * Compute trust-derived permission modes for each unique agent in the prompt entries.
 *
 * Opens the KG DB once, computes file insight maps once, then iterates entries.
 * If the KG DB does not exist or any query throws, returns an empty map so that
 * the worktreePath fallback in resolveToolProfile handles all entries.
 *
 * Known Phase 1 limitation: The trust map is keyed by agent name.
 * In wave states, multiple entries may share the same agent type but target
 * different task scopes — all get the same trust level in Phase 1.
 * Phase 2 should key trust computation by entry index or task ID.
 *
 * @returns Map<agentName, "auto" | "prompt"> — empty when trust computation is unavailable.
 */
/** Compute trust for each unique agent using KG metrics. */
function computeAgentTrust(
  entries: SpawnPromptEntry[],
  kgCtx: {
    kgQuery: KgQuery;
    insightMaps: ReturnType<typeof computeFileInsightMaps>;
    taskScope: string[];
    kgFreshnessMs: number | null;
  },
): Map<string, "auto" | "prompt"> {
  const result = new Map<string, "auto" | "prompt">();
  const uniqueAgents = new Set(entries.map((e) => e.agent));

  for (const agentName of uniqueAgents) {
    const fileMetrics = kgCtx.taskScope.map((filePath) =>
      kgCtx.kgQuery.getFileMetrics(filePath, kgCtx.insightMaps),
    );
    const scopeMetrics = buildScopeMetrics(
      fileMetrics.map((m) =>
        m === null ? null : { inCycle: m.in_cycle, inDegree: m.in_degree, isHub: m.is_hub },
      ),
    );
    const trustResult = computeTrustLevel({
      agent: agentName,
      agentCanWrite: agentHasWriteCapability(agentName),
      kgFreshnessMs: kgCtx.kgFreshnessMs,
      scopeMetrics,
      taskScope: kgCtx.taskScope,
    });
    result.set(agentName, trustLevelToPermissionMode(trustResult.level));
  }
  return result;
}

function computeTrustForEntries(
  entries: SpawnPromptEntry[],
  ctx: PromptContext,
): Map<string, "auto" | "prompt"> {
  const projectDir = ctx.input.project_dir ?? process.env.CANON_PROJECT_DIR ?? process.cwd();
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);

  if (!existsSync(dbPath)) return new Map();

  let board: Board | null = ctx.board ?? null;
  if (board === null) board = lazyLoadBoard(ctx.input.workspace);

  let db: ReturnType<typeof initDatabase> | undefined;
  try {
    db = initDatabase(dbPath);
    const kgQuery = new KgQuery(db);
    const insightMaps = computeFileInsightMaps(db);
    const kgFreshnessMs = kgQuery.getKgFreshnessMs();

    const planSlug = ctx.input.variables["${plan_slug}"] ?? ctx.input.variables.plan_slug;
    const taskId = ctx.input.variables["${task_id}"] ?? ctx.input.variables.task_id;
    const taskScope =
      board !== null
        ? resolveTaskScope({
            board,
            planSlug,
            stateId: ctx.input.state_id,
            taskId,
            workspace: ctx.input.workspace,
          })
        : [];

    return computeAgentTrust(entries, { insightMaps, kgFreshnessMs, kgQuery, taskScope });
  } catch {
    return new Map();
  } finally {
    closeDb(db);
  }
}

/**
 * Extract task_id from an item, if the item is a structured record containing task_id.
 */
function extractTaskId(item: TaskItem | undefined): string | undefined {
  if (item === undefined || typeof item === "string") return undefined;
  const val = (item as Record<string, unknown>).task_id;
  return typeof val === "string" ? val : undefined;
}

/**
 * Build the commit provenance section injected into every spawn prompt.
 * Agents must append these trailers to all commits (wip and feat).
 *
 * Returns empty string when the session slug is unavailable.
 */
function buildProvenanceSection(
  workspace: string,
  agent: string,
  stateId: string,
  taskId: string | undefined,
): string {
  let slug: string;
  try {
    const session = getExecutionStore(workspace).getSession();
    if (!session?.slug) return "";
    slug = session.slug;
  } catch {
    return "";
  }

  const trailerBlock = formatCommitTrailers({ agent, state: stateId, taskId, workflow: slug });
  if (!trailerBlock) return "";

  return `## Commit Provenance

Append these git trailers to ALL commit messages (both \`wip\` and \`feat\`). Place them after the commit body, before \`Co-Authored-By\`:

\`\`\`
${trailerBlock}
\`\`\``;
}

/**
 * Build the metrics footer to append to every prompt entry.
 * Contains a concrete record_agent_metrics invocation example with the
 * real workspace and state_id so agents receive a runnable example.
 */
function buildMetricsFooter(workspace: string, stateId: string): string {
  return `## Performance Metrics

Before returning your final status, call the \`record_agent_metrics\` tool to record your session counters:

record_agent_metrics({
  workspace: ${JSON.stringify(workspace)},
  state_id: ${JSON.stringify(stateId)},
  tool_calls: <total tool invocations you made>,
  orientation_calls: <Read/Glob/Grep calls made for orientation before writing>,
  turns: <number of assistant turns in your conversation>
})

- Count every tool invocation (Read, Write, Edit, Bash, Glob, Grep, etc.) toward tool_calls
- Count Read/Glob/Grep calls made before your first Write/Edit/Bash-write toward orientation_calls
- Count each assistant response as one turn
- If you cannot count accurately, omit that field — partial data is better than wrong data
- If the tool call fails, continue with your work — metrics are best-effort`;
}

/**
 * Stage 8: Inject role substitution, metrics footer, and tool scope metadata.
 */
export async function injectCoordination(ctx: PromptContext): Promise<PromptContext> {
  const { state } = ctx;
  const { state_id, workspace, role } = ctx.input;
  let prompts = [...ctx.prompts];

  // 1. Role substitution for single-role states
  if (role && state.type === "single") {
    prompts = prompts.map((entry) => ({
      ...entry,
      prompt: substituteVariables(entry.prompt, { role }),
      role,
    }));
  }

  // 2. (Removed) Messaging coordination instructions were previously injected here for
  // wave/parallel-per states. Debate/compete flows use buildDebatePrompt in debate.ts instead.
  // Wave events (orchestrator-injected) are still handled via get_messages(include_events: true).

  // 3. Append metrics instruction footer to all prompts (unconditional)
  const metricsFooter = buildMetricsFooter(workspace, state_id);
  prompts = prompts.map((entry) => ({
    ...entry,
    prompt: `${entry.prompt}\n\n${metricsFooter}`,
  }));

  // 3.5. Inject commit provenance section into all prompts (unconditional)
  // Each prompt entry may have a different task_id (wave tasks), so compute per-entry.
  prompts = prompts.map((entry) => {
    const taskId = extractTaskId(entry.item);
    const provenanceSection = buildProvenanceSection(workspace, entry.agent, state_id, taskId);
    if (!provenanceSection) return entry;
    return { ...entry, prompt: `${entry.prompt}\n\n${provenanceSection}` };
  });

  // 4. Inject tool scope metadata (ADR-014)
  // tool_overrides is present on all StateDefinition variants via BaseStateFields —
  // no cast or runtime guard needed.
  const toolOverrides: ToolOverrides | undefined = state.tool_overrides;

  // Compute trust-derived permission modes from KG when available.
  // Returns empty map on KG absence/error — resolveToolProfile falls back to worktreePath check.
  const trustPermissionModes = computeTrustForEntries(prompts, ctx);

  prompts = prompts.map((entry) => {
    const resolved = resolveToolProfile(entry.agent, {
      overrides: toolOverrides,
      trustPermissionMode: trustPermissionModes.get(entry.agent),
      worktreePath: entry.worktree_path,
    });
    const updated: typeof entry = {
      ...entry,
      disallowed_tools: resolved.disallowed_tools,
      permission_mode: resolved.permission_mode,
      tools: resolved.tools,
    };
    if (resolved.warnings) updated.tool_scope_warnings = resolved.warnings;
    return updated;
  });

  return { ...ctx, prompts };
}
