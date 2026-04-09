/**
 * Stage 8: inject-coordination
 *
 * Applies four types of coordination injection to fanned-out prompts:
 *
 * 1. **Role substitution** (single states only): when ctx.role is set,
 *    substitutes `${role}` in all prompt entries and sets entry.role.
 *
 * 2. **Messaging instructions** (wave/parallel-per with wave set): injects
 *    wave coordination instructions so agents can communicate via post_message
 *    / get_messages.
 *
 * 3. **Metrics footer** (all prompts, unconditional): appends the
 *    record_agent_metrics instruction with concrete workspace and state_id
 *    values. Every prompt entry receives this footer regardless of state type.
 *
 * 4. **Tool scope metadata** (ADR-014, all prompts, unconditional): resolves
 *    and sets `tools`, `disallowed_tools`, and `permission_mode` on every
 *    prompt entry based on the agent type, optional per-state tool_overrides,
 *    and whether the entry has a worktree_path (the sole permission mode signal).
 *    Permission mode is informed by the KG trust resolver when available.
 *
 * Canon: functions-do-one-thing — four related but distinct injection
 * operations, all concerning coordination and observability metadata.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { ToolOverrides } from "@domains/flows/flow-definition-schemas.ts";
import { buildMessageInstructions } from "@domains/messages/messages.ts";
import { substituteVariables } from "@domains/messages/variables.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { resolveTaskScope } from "@features/orchestration/services/scope-resolver.ts";
import { computeFileInsightMaps, KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { AGENT_TOOL_PROFILES, EMPTY_PROFILE, resolveToolProfile } from "../model/tool-profiles.ts";
import {
  buildScopeMetrics,
  computeTrustLevel,
  trustLevelToPermissionMode,
} from "./trust-resolver.ts";
import type { PromptContext, SpawnPromptEntry } from "../model/types.ts";

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
 * the static isolation fallback in resolveToolProfile handles all entries.
 *
 * Known Phase 1 limitation: The trust map is keyed by agent name.
 * In wave states, multiple entries may share the same agent type but target
 * different task scopes — all get the same trust level in Phase 1.
 * Phase 2 should key trust computation by entry index or task ID.
 *
 * @returns Map<agentName, "auto" | "prompt"> — empty when trust computation is unavailable.
 */
function computeTrustForEntries(
  entries: SpawnPromptEntry[],
  ctx: PromptContext,
): Map<string, "auto" | "prompt"> {
  const trustPermissionModes = new Map<string, "auto" | "prompt">();

  const projectDir =
    ctx.input.project_dir ?? process.env.CANON_PROJECT_DIR ?? process.cwd();
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);

  // If KG DB does not exist, skip trust computation entirely.
  // The worktreePath fallback in resolveToolProfile handles this case.
  if (!existsSync(dbPath)) {
    return trustPermissionModes;
  }

  // Resolve board lazily if not present in context
  let board: Board | null = ctx.board ?? null;
  if (board === null) {
    board = lazyLoadBoard(ctx.input.workspace);
    // If board still null, proceed with empty scope → LOW → prompt (fail-closed)
  }

  let db: ReturnType<typeof initDatabase> | undefined;
  try {
    db = initDatabase(dbPath);
    const kgQuery = new KgQuery(db);

    // Compute insight maps once — avoid N+1 queries across entries
    const insightMaps = computeFileInsightMaps(db);
    const kgFreshnessMs = kgQuery.getKgFreshnessMs();

    // Resolve task scope once — used for all entries (Phase 1 uniform trust)
    const planSlug = ctx.input.variables["${plan_slug}"] ?? ctx.input.variables["plan_slug"];
    const taskId = ctx.input.variables["${task_id}"] ?? ctx.input.variables["task_id"];
    const taskScope =
      board !== null
        ? resolveTaskScope({
            workspace: ctx.input.workspace,
            stateId: ctx.input.state_id,
            board,
            planSlug,
            taskId,
          })
        : [];

    // Deduplicate agent names — Phase 1: all entries with the same agent get the same trust
    const uniqueAgents = new Set(entries.map((e) => e.agent));

    for (const agentName of uniqueAgents) {
      const agentCanWrite = agentHasWriteCapability(agentName);

      // Get file metrics for each scope file
      const fileMetrics = taskScope.map((filePath) =>
        kgQuery.getFileMetrics(filePath, insightMaps),
      );
      const scopeMetrics = buildScopeMetrics(
        fileMetrics.map((m) =>
          m === null
            ? null
            : { isHub: m.is_hub, inDegree: m.in_degree, inCycle: m.in_cycle },
        ),
      );

      const trustResult = computeTrustLevel({
        agent: agentName,
        agentCanWrite,
        taskScope,
        scopeMetrics,
        kgFreshnessMs,
      });

      trustPermissionModes.set(agentName, trustLevelToPermissionMode(trustResult.level));
    }
  } catch {
    // Any KG error falls through to empty map → worktreePath fallback (fail-closed)
    trustPermissionModes.clear();
  } finally {
    closeDb(db);
  }

  return trustPermissionModes;
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
 * Stage 8: Inject role substitution, messaging instructions, and metrics footer.
 */
export async function injectCoordination(ctx: PromptContext): Promise<PromptContext> {
  const { state } = ctx;
  const { state_id, workspace, wave, peer_count, role } = ctx.input;
  let prompts = [...ctx.prompts];

  // 1. Role substitution for single-role states
  if (role && state.type === "single") {
    prompts = prompts.map((entry) => ({
      ...entry,
      prompt: substituteVariables(entry.prompt, { role }),
      role,
    }));
  }

  // 2. Inject messaging coordination instructions for wave/parallel-per states
  if ((state.type === "wave" || state.type === "parallel-per") && wave != null) {
    const peerCount = peer_count ?? prompts.length - 1;
    const channel = `wave-${String(wave).padStart(3, "0")}`;
    const messageInstr = buildMessageInstructions(channel, peerCount, workspace);
    prompts = prompts.map((entry) => ({
      ...entry,
      prompt: `${entry.prompt}\n\n${messageInstr}`,
    }));
  }

  // 3. Append metrics instruction footer to all prompts (unconditional)
  const metricsFooter = buildMetricsFooter(workspace, state_id);
  prompts = prompts.map((entry) => ({
    ...entry,
    prompt: `${entry.prompt}\n\n${metricsFooter}`,
  }));

  // 4. Inject tool scope metadata (ADR-014)
  // tool_overrides is present on all StateDefinition variants via BaseStateFields —
  // no cast or runtime guard needed.
  const toolOverrides: ToolOverrides | undefined = state.tool_overrides;

  // Compute trust-derived permission modes from KG when available.
  // Returns empty map on KG absence/error — resolveToolProfile falls back to static isolation check.
  const trustPermissionModes = computeTrustForEntries(prompts, ctx);

  prompts = prompts.map((entry) => {
    const resolved = resolveToolProfile(entry.agent, {
      overrides: toolOverrides,
      worktreePath: entry.worktree_path,
      trustPermissionMode: trustPermissionModes.get(entry.agent),
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
