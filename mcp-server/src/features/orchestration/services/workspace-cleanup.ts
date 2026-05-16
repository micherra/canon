import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { archiveWorkspace } from "@features/history/services/archive-service.ts";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { appendFlowRun, type FlowRunEntry } from "@platform/storage/drift/analytics.ts";
import { releaseClaims } from "@shared/lib/file-claims.ts";
import { generateId } from "@shared/lib/id.ts";
import { projectDir } from "../../../app/server-state.ts";
import type { JournalStep } from "../tools/orchestration-journal.ts";
import { computeFlowOutcome } from "../tools/orchestration-journal.ts";

/** Best-effort branch delete after worktree removal. Never throws. */
function tryDeleteBranch(slug: string): void {
  try {
    const r = gitExec(["branch", "-D", `canon/${slug}`], projectDir);
    if (!r.ok) console.warn(`[canon] branch -D failed for ${slug}:`, r.stderr.trim());
  } catch (err: unknown) {
    console.warn(`[canon] branch -D threw for ${slug}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Deregister the worktree at `{workspace}/worktree` from git before deletion.
 * Best-effort — never throws. Warns on failure so the caller can still proceed.
 */
function tryDeregisterWorktree(workspace: string, slug: string): void {
  const worktreeSubPath = join(workspace, "worktree");
  if (!existsSync(worktreeSubPath)) return;
  try {
    const result = gitExec(["worktree", "remove", "--force", worktreeSubPath], projectDir);
    if (!result.ok) {
      console.warn(
        `[canon] archiveAndDeleteWorkspace: git worktree remove failed for ${basename(workspace)}:`,
        result.stderr.trim(),
      );
    } else {
      tryDeleteBranch(slug);
    }
  } catch (err: unknown) {
    console.warn(
      `[canon] archiveAndDeleteWorkspace: git worktree remove threw for ${basename(workspace)}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export async function archiveAndDeleteWorkspace(
  workspace: string,
): Promise<{ archived: boolean; deleted: boolean }> {
  const session = getExecutionStore(workspace).getSession();
  const slug = session?.slug ?? basename(workspace);

  let archived = false;
  try {
    const branch = session?.branch ?? "unknown";
    await archiveWorkspace({
      branch,
      projectDir,
      slug,
      workspacePath: workspace,
    });
    archived = true;
  } catch (err: unknown) {
    console.warn("[canon] workspace archive failed:", err instanceof Error ? err.message : err);
  }

  let deleted = false;
  try {
    tryDeregisterWorktree(workspace, slug);
    rmSync(workspace, { force: true, recursive: true });
    deleted = true;
  } catch (err: unknown) {
    console.warn("[canon] workspace deletion failed:", err instanceof Error ? err.message : err);
  }

  return { archived, deleted };
}

/**
 * Release file claims for this workspace's slug. Best-effort — never throws.
 * Returns true when claims were released successfully, false when skipped or failed.
 */
export async function tryReleaseClaims(workspace: string): Promise<boolean> {
  try {
    const session = getExecutionStore(workspace).getSession();
    if (!session) return false;
    releaseClaims(projectDir, session.slug);
    return true;
  } catch (err: unknown) {
    console.warn(
      "[canon] finalizeWorkspace: failed to release file claims:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Build a minimal FlowRunEntry from journal step timestamps and append to drift analytics.
 * Best-effort — never throws. Returns true when analytics were recorded, false otherwise.
 */
export async function tryAppendAnalytics(
  workspace: string,
  steps: readonly JournalStep[],
): Promise<boolean> {
  try {
    const session = getExecutionStore(workspace).getSession();
    const now = new Date().toISOString();
    const flowOutcome = computeFlowOutcome(steps);
    const flowRun: FlowRunEntry = {
      completed: now,
      flow: session?.slug ?? basename(workspace),
      run_id: generateId("run"),
      skipped_states: steps.filter((s) => s.status === "skipped").map((s) => s.step_id),
      started: steps.find((s) => s.started_at)?.started_at ?? now,
      state_durations: {},
      state_iterations: {},
      task: session?.slug ?? basename(workspace),
      tier: "unknown",
      total_duration_ms: flowOutcome.total_duration_ms ?? 0,
      total_spawns: 0,
    };
    await appendFlowRun(projectDir, flowRun);
    return true;
  } catch (err: unknown) {
    console.warn(
      "[canon] finalizeWorkspace: failed to append flow analytics:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Run the janitor for background housekeeping. Best-effort — never throws.
 */
export async function tryRunJanitor(): Promise<void> {
  try {
    const { runJanitor } = await import("../services/janitor.ts");
    await runJanitor(projectDir);
  } catch (err: unknown) {
    console.warn(
      "[canon] finalizeWorkspace: janitor run failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
