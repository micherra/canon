/**
 * orchestrator-checkpoint — derived compact resume-state snapshot.
 *
 * A single MCP tool `write_orchestrator_checkpoint` that:
 *  1. Reads journal state via `readJournal` (existing export)
 *  2. Reads recent decisions via `getDecisions` (from decisions-ledger.ts)
 *  3. Derives compact resume state (current/completed/pending steps, recent decisions, next action)
 *  4. Writes the result to `${workspace}/checkpoint.md` atomically
 *
 * This is a DERIVED SNAPSHOT (ledger-d3) — it is regenerated from journal + decisions
 * on every call. The journal + decisions ledger are the authoritative sources; the
 * checkpoint is a fast read-optimized projection.
 *
 * Write posture: BEST-EFFORT-OBSERVABLE (observable-best-effort principle).
 * A write failure warns AND returns a ToolResult error; never a silent no-op claiming success.
 * This is distinct from the authoritative ledger write (logDecision) which does NOT wrap
 * appendEvent in a fail-open catch.
 *
 * See DESIGN.md Workstream B and ledger-02-PLAN.md for rationale.
 */

import { isAbsolute, join } from "node:path";
import type { DecisionRecord } from "@features/orchestration/tools/decisions-ledger.ts";
import {
  getDecisions,
  renderDecisionsTable,
} from "@features/orchestration/tools/decisions-ledger.ts";
import { readJournal } from "@features/orchestration/tools/orchestration-journal.ts";
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Input for the write_orchestrator_checkpoint command.
 *
 * @param workspace - Absolute path to the Canon workspace directory.
 * @param next_action - Optional explicit next-action hint; if absent, derived from the first
 *   non-terminal step in the journal.
 * @param projectDir - Injected by resolveScope(extra).
 */
export type WriteCheckpointInput = {
  workspace: string;
  next_action?: string;
  projectDir?: string;
};

/** Return value for write_orchestrator_checkpoint. */
export type WriteCheckpointResult = {
  path: string;
  written: true;
};

/** A pending step record for the checkpoint render. */
type PendingStep = {
  step_id: string;
  status: string;
};

/** Arguments for renderCheckpoint — pure, no I/O. */
type RenderCheckpointArgs = {
  workspace: string;
  current: string;
  nextAction: string;
  completed: string[];
  pending: PendingStep[];
  decisions: DecisionRecord[];
};

// ── Pure render ───────────────────────────────────────────────────────────────

/**
 * Render a compact orchestrator checkpoint markdown document.
 *
 * This is a PURE function — no I/O, deterministic output.
 * The checkpoint notes that the durable sources (journal + decisions ledger) are
 * authoritative; this file is a fast-read projection.
 *
 * @param args - Derived state from journal and decisions ledger.
 * @returns Compact markdown string for writing to checkpoint.md.
 */
export function renderCheckpoint(args: RenderCheckpointArgs): string {
  const { completed, current, decisions, nextAction, pending } = args;
  const now = new Date().toISOString();

  const completedList =
    completed.length > 0 ? completed.map((id) => `- ${id}`).join("\n") : "_none_";

  const pendingList =
    pending.length > 0 ? pending.map((s) => `- ${s.step_id} (${s.status})`).join("\n") : "_none_";

  const decisionsBlock = decisions.length > 0 ? renderDecisionsTable(decisions) : "_none_";

  return [
    "# Orchestrator Checkpoint",
    `_Refreshed: ${now}_  (regenerated from journal + decisions ledger — authoritative sources, not this file)`,
    "",
    "## Current step",
    current || "_none_",
    "",
    "## Next action",
    nextAction || "_none_",
    "",
    "## Completed steps",
    completedList,
    "",
    "## Pending steps",
    pendingList,
    "",
    "## Recent decisions (last 10)",
    decisionsBlock,
  ].join("\n");
}

// ── Command: writeOrchestratorCheckpoint ──────────────────────────────────────

/**
 * Write a derived compact resume-state snapshot to `${workspace}/checkpoint.md`.
 *
 * Derives state from:
 *  - `readJournal(workspace)` → completed / pending / current step
 *  - `getDecisions(workspace)` → last 10 orchestrator decisions
 *
 * Write posture: best-effort-observable.
 * - On write failure: warns and returns a ToolResult error (not a throw, not silent success).
 * - On decisions-unavailable: still writes the checkpoint with a "_none_" decisions block.
 *
 * @param input - Workspace path and optional next_action hint.
 * @returns `{ path, written: true }` on success.
 * @returns ToolResult error on validation failure or write failure.
 */
export async function writeOrchestratorCheckpoint(
  input: WriteCheckpointInput,
): Promise<ToolResult<WriteCheckpointResult>> {
  const { next_action, workspace } = input;

  // Validate workspace is absolute
  if (!workspace || !isAbsolute(workspace)) {
    return toolError(
      "INVALID_INPUT",
      `workspace must be a non-empty absolute path; got: "${workspace}"`,
    );
  }

  // Read journal state — this is cheap and always available
  const journal = await readJournal(workspace);
  const { steps } = journal;

  const completed = steps.filter((s) => s.status === "completed").map((s) => s.step_id);
  const pendingSteps: PendingStep[] = steps
    .filter((s) => s.status === "started" || s.status === "planned")
    .map((s) => ({ status: s.status, step_id: s.step_id }));

  // Current = last completed, or first started, or "none"
  const lastCompleted = [...steps].reverse().find((s) => s.status === "completed");
  const firstStarted = steps.find((s) => s.status === "started");
  const current = (lastCompleted ?? firstStarted)?.step_id ?? "none";

  // Next step = first non-terminal step
  const nextStep = steps.find((s) => s.status === "started" || s.status === "planned")?.step_id;
  const nextAction = next_action ?? nextStep ?? "none";

  // Read recent decisions — best-effort (checkpoint is best-effort w.r.t. decisions)
  let recentDecisions: DecisionRecord[] = [];
  const decResult = await getDecisions({ projectDir: input.projectDir, workspace });
  if (decResult.ok) {
    // Take last 10 decisions
    recentDecisions = decResult.decisions.slice(-10);
  }
  // If getDecisions fails: recentDecisions stays empty → renders "_none_" block

  const md = renderCheckpoint({
    completed,
    current,
    decisions: recentDecisions,
    nextAction,
    pending: pendingSteps,
    workspace,
  });

  // Atomic write — explicit-transaction-boundaries: single temp+rename, no partial file lands
  const checkpointPath = join(workspace, "checkpoint.md");
  try {
    await atomicWriteFile(checkpointPath, md);
  } catch (err) {
    // Best-effort-observable: warn AND return a ToolResult error; never silent no-op
    console.warn("[canon] orchestrator-checkpoint: write failed:", err);
    return toolError("UNEXPECTED", `checkpoint write failed: ${String(err)}`);
  }

  return toolOk({ path: checkpointPath, written: true as const });
}
