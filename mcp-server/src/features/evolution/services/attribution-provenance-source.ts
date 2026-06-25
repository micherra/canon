/**
 * attribution-provenance-source.ts — Source-agnostic provenance reader.
 *
 * Returns ContextProvenanceSummary[] from either:
 *   - LIVE workspace: reads raw context_provenance + context_provenance_agent_id events
 *     via the execution store and applies the same back-fill join as
 *     run-summary-builder.ts::extractContextProvenance (local replication to respect
 *     bounded-context boundaries — do NOT import from platform/storage/archive/).
 *   - ARCHIVED build: loads archived run-summary.json and returns context_provenance ?? [].
 *
 * Fail-open: any error returns []. Never throws.
 *
 * Canon principles:
 *   - observable-best-effort: absent provenance → [] (partial output, not error)
 *   - bounded-context-boundaries: does not import from platform/storage/archive features;
 *     replicates the small join locally instead of importing across bounded contexts
 *   - errors-are-values: all errors surfaced as empty [] (fail-open by design for provenance)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AssembledArtifact,
  ContextProvenanceSummary,
} from "@domains/workspaces/context-provenance.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type ProvenanceSourceInput =
  | { kind: "live"; workspace: string }
  | { kind: "archived"; archive_id: string; project_dir: string };

/**
 * Read ContextProvenanceSummary[] from a live workspace or an archived build.
 * Fail-open: any error returns [].
 */
export function readProvenance(input: ProvenanceSourceInput): ContextProvenanceSummary[] {
  try {
    if (input.kind === "live") {
      return readLiveProvenance(input.workspace);
    }
    return readArchivedProvenance(input.archive_id, input.project_dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Live workspace read (replicates run-summary-builder extractContextProvenance)
// ---------------------------------------------------------------------------

/**
 * Reads context_provenance events from the live workspace execution store.
 * Joins agent_id from context_provenance_agent_id back-fill events (latest wins per step_id).
 *
 * This is a local replication of the run-summary-builder.ts::extractContextProvenance
 * logic, respecting bounded-context boundaries (do not import from platform/storage/archive/).
 */
function readLiveProvenance(workspace: string): ContextProvenanceSummary[] {
  try {
    const store = getExecutionStore(workspace);
    const provEvents = store.getEventsByType("context_provenance");
    const backfills = store.getEventsByType("context_provenance_agent_id");

    // Build step_id → latest agent_id map (back-fill wins, latest event per step_id wins)
    const agentByStep = new Map<string, string>();
    for (const ev of backfills) {
      const sid = ev.payload.step_id;
      const aid = ev.payload.agent_id;
      if (typeof sid === "string" && typeof aid === "string") {
        agentByStep.set(sid, aid);
      }
    }

    return provEvents.map((ev) => mapProvenanceEvent(ev, agentByStep));
  } catch {
    return [];
  }
}

/** Map a raw context_provenance event to a ContextProvenanceSummary. */
function mapProvenanceEvent(
  ev: { payload: Record<string, unknown> },
  agentByStep: Map<string, string>,
): ContextProvenanceSummary {
  const p = ev.payload;
  const stepId = typeof p.step_id === "string" ? p.step_id : null;
  const artifacts = Array.isArray(p.assembled_artifacts)
    ? (p.assembled_artifacts as AssembledArtifact[])
    : [];

  // Join: back-fill agent_id wins; fall back to inline agent_id; then null
  const joinedAgentId =
    (stepId !== null ? agentByStep.get(stepId) : undefined) ??
    (typeof p.agent_id === "string" ? p.agent_id : null);

  return {
    agent_id: joinedAgentId ?? null,
    agent_name: typeof p.agent_name === "string" ? p.agent_name : "",
    artifact_count: artifacts.length,
    artifacts,
    spawned_at: typeof p.spawned_at === "string" ? p.spawned_at : "",
    step_id: stepId,
  };
}

// ---------------------------------------------------------------------------
// Archived build read (reads run-summary.json from archive path)
// ---------------------------------------------------------------------------

/**
 * Reads context_provenance from an archived run-summary.json.
 * Uses getDriftDb.getArchiveById to resolve the archive path.
 */
function readArchivedProvenance(archiveId: string, projectDir: string): ContextProvenanceSummary[] {
  try {
    const db = getDriftDb(projectDir);
    const archive = db.getArchiveById(archiveId);
    if (archive === null) return [];

    const summaryPath = join(archive.archive_path, "run-summary.json");
    const raw = readFileSync(summaryPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== "object" || parsed === null || !("context_provenance" in parsed)) {
      return [];
    }

    const cp = (parsed as { context_provenance?: unknown }).context_provenance;
    if (!Array.isArray(cp)) return [];
    return cp as ContextProvenanceSummary[];
  } catch {
    return [];
  }
}
