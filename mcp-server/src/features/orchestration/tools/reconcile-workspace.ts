/**
 * reconcileWorkspace — cliff detection tool, read-only w.r.t. the journal/archive.
 *
 * Returns started/planned steps whose declared artifacts are either missing on
 * disk OR present but still a `## Status: Partial` / `IN_PROGRESS` skeleton.
 * Call on resume/turn-start to detect agents that stopped before producing (or
 * finishing) their artifacts. Never mutates the journal or archive and runs no
 * destructive side-effects. When `emit_telemetry: true` and a cliff is detected,
 * it appends a best-effort (fail-open) `cliff_detected` audit event to the
 * execution-store event log AND, when `projectDir` is supplied, writes a
 * durable row per incomplete step to drift.db via CliffEventsDao (decision
 * cliff-d2). Both writes are fail-open: a failure warns with context but never
 * alters the returned result.
 *
 * Extracted from orchestration-journal.ts to keep that file under 600 lines.
 */

import { existsSync, globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import type { JournalStep } from "./orchestration-journal.ts";
import {
  _journalPath as journalPath,
  readJournal,
  scanArtifactList,
} from "./orchestration-journal.ts";

export type ReconcileWorkspaceInput = {
  workspace: string;
  emit_telemetry?: boolean;
  source?: "resume" | "post_subagent" | "loop";
  projectDir?: string; // injected by register-journal.ts via resolveScope(extra); enables drift.db write-through
};

export type IncompleteStep = {
  step_id: string;
  agent_type: string | null;
  status: "started" | "planned";
  started_at?: string;
  missing_artifacts: string[]; // from scanArtifactList(step.artifacts_expected)
  partial_artifacts: string[]; // present on disk but still a Partial/IN_PROGRESS skeleton
  transcript_path?: string; // step.transcript_path if already captured
};

export type ReconcileWorkspaceResult = {
  workspace: string;
  // started|planned with >=1 missing OR partial artifact
  incomplete_steps: IncompleteStep[];
  needs_recovery: boolean; // incomplete_steps.length > 0
};

/**
 * Skeleton markers written by single-artifact agents on step 1 (per
 * `rules/agent-artifact-write-before-return.md`). A present artifact still
 * carrying one of these is a recoverable cliff, not a finished deliverable:
 * - `## Status: Partial` — architect, security skeletons
 * - `IN_PROGRESS` verdict — reviewer Early Output Protocol stub (frontmatter
 *   `verdict: IN_PROGRESS` and `## Canon Review — Verdict: IN_PROGRESS`)
 * - `IN_PROGRESS` status — scribe skeleton (frontmatter `status: "IN_PROGRESS"`,
 *   the context-sync template's own status field, per `templates/context-sync.md`)
 */
const PARTIAL_MARKERS: readonly RegExp[] = [
  /^#{1,6}\s*Status:\s*Partial\b/im,
  /^verdict:\s*IN_PROGRESS\b/im,
  /Verdict:\s*IN_PROGRESS\b/i,
  /^status:\s*["']?IN_PROGRESS["']?\b/im,
];

/** Resolve an artifact entry (plain path or glob) to concrete files, checking
 * both the workspace root and the worktree/ subdirectory (mirrors artifactExists). */
function resolveArtifactFiles(workspace: string, artifact: string): string[] {
  const files: string[] = [];
  for (const root of [workspace, join(workspace, "worktree")]) {
    for (const match of globSync(artifact, { cwd: root })) {
      files.push(join(root, match));
    }
  }
  return files;
}

/** True when any file the artifact resolves to still carries a skeleton marker. */
async function isPartialArtifact(workspace: string, artifact: string): Promise<boolean> {
  const files = resolveArtifactFiles(workspace, artifact);
  const checks = await Promise.all(
    files.map(async (file) => {
      try {
        const content = await readFile(file, "utf-8");
        const head = content.slice(0, 8192); // markers live in frontmatter / first heading
        return PARTIAL_MARKERS.some((re) => re.test(head));
      } catch {
        return false; // unreadable → not classifiable as partial here; missing-scan owns absence
      }
    }),
  );
  return checks.some(Boolean);
}

/** Of the present (non-missing, non-template) artifacts, those still partial. */
async function scanPartialArtifacts(
  workspace: string,
  artifacts: readonly string[],
  missing: readonly string[],
): Promise<string[]> {
  const candidates = artifacts.filter(
    (art) => !art.startsWith("outcome:") && !art.includes("${") && !missing.includes(art),
  );
  const partialFlags = await Promise.all(
    candidates.map((art) => isPartialArtifact(workspace, art)),
  );
  return candidates.filter((_, i) => partialFlags[i]);
}

/** Build an IncompleteStep entry from a journal step, or null if not incomplete. */
async function toIncompleteStep(
  workspace: string,
  step: JournalStep,
): Promise<IncompleteStep | null> {
  if (step.status !== "started" && step.status !== "planned") return null;
  const expected = step.artifacts_expected ?? [];
  const missing = scanArtifactList(workspace, expected);
  const partial = await scanPartialArtifacts(workspace, expected, missing);
  if (missing.length === 0 && partial.length === 0) return null;
  const incomplete: IncompleteStep = {
    agent_type: step.agent_type,
    missing_artifacts: missing,
    partial_artifacts: partial,
    status: step.status,
    step_id: step.step_id,
  };
  if (step.started_at) incomplete.started_at = step.started_at;
  if (step.transcript_path) incomplete.transcript_path = step.transcript_path;
  return incomplete;
}

/**
 * Append a `cliff_detected` audit event to the execution-store event log.
 *
 * Best-effort and fail-open: never throws, never changes the caller's result.
 * Mirrors the `auto_decision` precedent in `compute-autonomy-tier.ts`. The
 * journal/archive is never touched — only the append-only event log is written.
 *
 * Payload is enriched with a `steps` array (decision D6) so future backfills
 * carry per-step agent types and counts.
 */
function emitCliffTelemetry(
  workspace: string,
  incompleteSteps: IncompleteStep[],
  source: "resume" | "post_subagent" | "loop",
): void {
  try {
    const store = getExecutionStore(workspace);
    store.appendEvent("cliff_detected", {
      incomplete_step_ids: incompleteSteps.map((s) => s.step_id),
      missing_count: incompleteSteps.reduce((n, s) => n + s.missing_artifacts.length, 0),
      needs_recovery: true,
      partial_count: incompleteSteps.reduce((n, s) => n + s.partial_artifacts.length, 0),
      source,
      steps: incompleteSteps.map((s) => ({
        agent_type: s.agent_type,
        missing_count: s.missing_artifacts.length,
        partial_count: s.partial_artifacts.length,
        step_id: s.step_id,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Fail-open: telemetry must never block resume or the build (PRD constraint).
    console.warn(
      "[canon] reconcile-workspace: cliff_detected event logging failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Fail-open write-through of cliff events to the central drift.db store
 * (decision cliff-d2). Never throws; a failure warns and changes nothing
 * for the caller. Skipped when projectDir is unavailable.
 */
function writeCliffEventsThrough(
  projectDir: string,
  workspace: string,
  incompleteSteps: IncompleteStep[],
  source: "resume" | "post_subagent" | "loop",
): void {
  try {
    const dao = getDriftDb(projectDir).getCliffEvents();
    const detectedAt = new Date().toISOString();
    const slug = basename(workspace);
    for (const step of incompleteSteps) {
      dao.upsert({
        agent_type: step.agent_type ?? undefined,
        detected_at: detectedAt,
        missing_count: step.missing_artifacts.length,
        partial_count: step.partial_artifacts.length,
        source,
        step_id: step.step_id,
        workspace_slug: slug,
      });
    }
  } catch (err) {
    console.warn(
      "[canon] reconcile-workspace: cliff_events write-through to drift.db failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Reconciliation, read-only w.r.t. the journal/archive: return started/planned
 * steps whose declared artifacts are missing on disk (cliff detection). Call on
 * resume/turn-start to detect agents that stopped before producing their
 * artifacts.
 *
 * Never mutates the journal or archive. When `emit_telemetry: true` and a cliff
 * is detected, appends a best-effort (fail-open) `cliff_detected` audit event to
 * the execution-store event log; a telemetry-write failure never changes the
 * returned result.
 */
export async function reconcileWorkspace(
  input: ReconcileWorkspaceInput,
): Promise<ToolResult<ReconcileWorkspaceResult>> {
  const { workspace } = input;

  if (!workspace) {
    return toolError("INVALID_INPUT", "workspace must be a non-empty string", false);
  }

  if (!isAbsolute(workspace)) {
    return toolError("INVALID_INPUT", `workspace must be an absolute path; got: "${workspace}"`);
  }

  const path = journalPath(workspace);
  if (!existsSync(path)) {
    return toolError("WORKSPACE_NOT_FOUND", `No journal found at ${path}`, false, { workspace });
  }

  const { steps } = await readJournal(workspace);
  const incompleteSteps = (
    await Promise.all(steps.map((step) => toIncompleteStep(workspace, step)))
  ).filter((s): s is IncompleteStep => s !== null);

  if (input.emit_telemetry && incompleteSteps.length > 0) {
    const source = input.source ?? "resume";
    emitCliffTelemetry(workspace, incompleteSteps, source);
    if (input.projectDir) {
      writeCliffEventsThrough(input.projectDir, workspace, incompleteSteps, source);
    }
  }

  return toolOk({
    incomplete_steps: incompleteSteps,
    needs_recovery: incompleteSteps.length > 0,
    workspace,
  });
}
