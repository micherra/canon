/**
 * cliff-event-sweep — backfill cliff_detected events from live workspace DBs
 *
 * Scans projectDir/.canon/workspaces/[branch]/[slug]/orchestration.db for
 * cliff_detected events, upserts them into drift.db via CliffEventsDao, then
 * derives and writes recovery_outcome from journal.json for rows whose outcome
 * is still "unknown" or "unresolved".
 *
 * Design invariants:
 * - FAIL-OPEN: never throws; any per-workspace or per-journal failure is
 *   console.warn'd and skipped — the sweep returns a result on all paths.
 * - READ-ONLY w.r.t. workspace DBs: opens orchestration.db with {readonly:true};
 *   never calls getExecutionStore() on a foreign DB (that runs migrations).
 * - WRITE TARGET IS DRIFT.DB ONLY: only getDriftDb(projectDir).getCliffEvents().
 *
 * Canon principles applied:
 * - observable-best-effort: every skip recorded in skipped[] AND console.warn'd
 * - bounded-context-boundaries: imports only node:*, better-sqlite3, @platform/storage/drift/*
 * - validate-at-trust-boundaries: all foreign JSON parsed in try/catch and
 *   type-narrowed before use; malformed entries are skipped, not fatal
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CliffRecoveryOutcome } from "@platform/storage/drift/cliff-events-dao.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import Database from "better-sqlite3";

// ---- Public result type ----

export type SweepResult = {
  /** Number of workspace DB paths visited (successful or skipped). */
  scanned_workspaces: number;
  /** Number of newly inserted rows from workspace event logs. */
  events_ingested: number;
  /** Number of recovery_outcome transitions to "recovered" or "abandoned". */
  outcomes_updated: number;
  /** Unreadable/locked/malformed workspaces — observable for callers. */
  skipped: { path: string; reason: string }[];
};

// ---- Internal types for parsed data ----

type EnrichedStep = {
  step_id: string;
  agent_type?: string;
  missing_count?: number;
  partial_count?: number;
};

type CliffPayload = {
  workspace?: string;
  source?: string;
  timestamp?: string;
  needs_recovery?: boolean;
  incomplete_step_ids?: string[];
  steps?: EnrichedStep[];
};

type JournalStep = {
  step_id: string;
  agent_type?: string;
  status: string;
};

// ---- Named type guards (validate-at-trust-boundaries) ----

function isEnrichedStep(x: unknown): x is EnrichedStep {
  if (x === null || typeof x !== "object") return false;
  return typeof (x as Record<string, unknown>).step_id === "string";
}

function isCliffPayload(x: unknown): x is CliffPayload {
  return x !== null && typeof x === "object";
}

function isJournalStep(x: unknown): x is JournalStep {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.step_id === "string" && typeof o.status === "string";
}

// ---- Payload parsing ----

function parsePayload(raw: string): CliffPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCliffPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---- Journal path resolution ----

// Locate journal.json for a workspace_slug.
// Search order:
//   1. Live: projectDir/.canon/workspaces/[branch]/[slug]/journal.json
//   2. Archived: projectDir/.canon/history/[slug]/journal.json
// Returns null when not found.
function findJournalPath(projectDir: string, workspaceSlug: string): string | null {
  const workspacesRoot = join(projectDir, ".canon", "workspaces");

  if (existsSync(workspacesRoot)) {
    let branchDirs: string[] = [];
    try {
      branchDirs = readdirSync(workspacesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      // Can't enumerate branch dirs — skip live search
    }

    for (const branchDir of branchDirs) {
      const candidate = join(workspacesRoot, branchDir, workspaceSlug, "journal.json");
      if (existsSync(candidate)) return candidate;
    }
  }

  const archivedPath = join(projectDir, ".canon", "history", workspaceSlug, "journal.json");
  return existsSync(archivedPath) ? archivedPath : null;
}

function readJournal(journalPath: string): Map<string, JournalStep> | null {
  try {
    const raw = readFileSync(journalPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const steps = obj.steps;
    if (!Array.isArray(steps)) return null;
    const validSteps = steps.filter(isJournalStep);
    const index = new Map<string, JournalStep>();
    for (const step of validSteps) index.set(step.step_id, step);
    return index;
  } catch {
    return null;
  }
}

// ---- Outcome derivation (decision D4) ----

// completed→recovered, skipped→abandoned, started/planned/other (journal found)→unresolved
function deriveOutcomeFromStatus(status: string): CliffRecoveryOutcome {
  if (status === "completed") return "recovered";
  if (status === "skipped") return "abandoned";
  return "unresolved";
}

// ---- Step upsert helpers ----

type UpsertStepArgs = {
  slug: string;
  stepId: string;
  agentType: string | undefined;
  detectedAt: string;
  source: string;
  missingCount: number | undefined;
  partialCount: number | undefined;
  projectDir: string;
  existingKeys: Set<string>;
};

function upsertStep(args: UpsertStepArgs): boolean {
  const {
    slug,
    stepId,
    agentType,
    detectedAt,
    source,
    missingCount,
    partialCount,
    projectDir,
    existingKeys,
  } = args;
  const key = `${slug}:${stepId}`;
  const isNew = !existingKeys.has(key);
  getDriftDb(projectDir).getCliffEvents().upsert({
    agent_type: agentType,
    detected_at: detectedAt,
    missing_count: missingCount,
    partial_count: partialCount,
    recovery_outcome: "unknown",
    source,
    step_id: stepId,
    workspace_slug: slug,
  });
  return isNew;
}

type ProcessStepsCtx = {
  slug: string;
  detectedAt: string;
  source: string;
  projectDir: string;
  existingKeys: Set<string>;
};

function processEnrichedSteps(steps: EnrichedStep[], ctx: ProcessStepsCtx): number {
  let count = 0;
  for (const rawStep of steps) {
    if (!isEnrichedStep(rawStep)) continue;
    const isNew = upsertStep({
      agentType: typeof rawStep.agent_type === "string" ? rawStep.agent_type : undefined,
      detectedAt: ctx.detectedAt,
      existingKeys: ctx.existingKeys,
      missingCount: typeof rawStep.missing_count === "number" ? rawStep.missing_count : undefined,
      partialCount: typeof rawStep.partial_count === "number" ? rawStep.partial_count : undefined,
      projectDir: ctx.projectDir,
      slug: ctx.slug,
      source: ctx.source,
      stepId: rawStep.step_id,
    });
    if (isNew) count++;
  }
  return count;
}

function processLegacyStepIds(stepIds: string[], ctx: ProcessStepsCtx): number {
  let count = 0;
  for (const stepId of stepIds) {
    if (typeof stepId !== "string") continue;
    const isNew = upsertStep({
      agentType: undefined,
      detectedAt: ctx.detectedAt,
      existingKeys: ctx.existingKeys,
      missingCount: undefined,
      partialCount: undefined,
      projectDir: ctx.projectDir,
      slug: ctx.slug,
      source: ctx.source,
      stepId,
    });
    if (isNew) count++;
  }
  return count;
}

// ---- Per-workspace ingestion ----

// Open a single orchestration.db (read-only), extract cliff_detected events,
// upsert each step into drift.db. Returns new row count or throws on DB error.
function ingestWorkspaceDb(dbPath: string, workspaceSlug: string, projectDir: string): number {
  let workspaceDb: InstanceType<typeof Database> | null = null;
  let ingested = 0;

  try {
    workspaceDb = new Database(dbPath, { readonly: true });

    const rows = workspaceDb
      .prepare("SELECT payload, timestamp FROM events WHERE type = 'cliff_detected'")
      .all() as Array<{ payload: string; timestamp: string }>;

    const cliffDao = getDriftDb(projectDir).getCliffEvents();
    const existingKeys = new Set<string>(
      cliffDao.getByWorkspace(workspaceSlug).map((r) => `${r.workspace_slug}:${r.step_id}`),
    );

    for (const row of rows) {
      const payload = parsePayload(row.payload);
      if (payload === null) continue;

      const detectedAt = payload.timestamp ?? row.timestamp;
      const source = payload.source ?? "resume";

      const ctx: ProcessStepsCtx = {
        detectedAt,
        existingKeys,
        projectDir,
        slug: workspaceSlug,
        source,
      };
      if (Array.isArray(payload.steps) && payload.steps.length > 0) {
        ingested += processEnrichedSteps(payload.steps, ctx);
      } else if (Array.isArray(payload.incomplete_step_ids)) {
        ingested += processLegacyStepIds(payload.incomplete_step_ids, ctx);
      }
    }
  } finally {
    try {
      workspaceDb?.close();
    } catch {
      // suppress close errors
    }
  }

  return ingested;
}

// ---- Outcome enrichment per slug ----

type EnrichRowArgs = {
  row: {
    workspace_slug: string;
    step_id: string;
    agent_type: string | null;
    detected_at: string;
    source: string;
    missing_count: number | null;
    partial_count: number | null;
    recovery_outcome: CliffRecoveryOutcome;
  };
  journalStep: JournalStep;
  projectDir: string;
};

function enrichRow(args: EnrichRowArgs): boolean {
  const { row, journalStep, projectDir } = args;
  const cliffDao = getDriftDb(projectDir).getCliffEvents();
  const newOutcome = deriveOutcomeFromStatus(journalStep.status);
  const isTerminal = newOutcome === "recovered" || newOutcome === "abandoned";
  const outcomeChanged = newOutcome !== row.recovery_outcome;

  const recoveredAgentType =
    row.agent_type === null && typeof journalStep.agent_type === "string"
      ? journalStep.agent_type
      : undefined;

  if (recoveredAgentType !== undefined) {
    cliffDao.upsert({
      agent_type: recoveredAgentType,
      detected_at: row.detected_at,
      missing_count: row.missing_count ?? undefined,
      partial_count: row.partial_count ?? undefined,
      recovery_outcome: newOutcome,
      source: row.source,
      step_id: row.step_id,
      workspace_slug: row.workspace_slug,
    });
  } else if (outcomeChanged) {
    cliffDao.updateOutcome(row.workspace_slug, row.step_id, newOutcome);
  }

  return isTerminal && outcomeChanged;
}

function enrichSlug(
  slug: string,
  rows: Array<{
    workspace_slug: string;
    step_id: string;
    agent_type: string | null;
    detected_at: string;
    source: string;
    missing_count: number | null;
    partial_count: number | null;
    recovery_outcome: CliffRecoveryOutcome;
  }>,
  projectDir: string,
): number {
  const journalPath = findJournalPath(projectDir, slug);
  if (journalPath === null) return 0;

  let stepIndex: Map<string, JournalStep> | null;
  try {
    stepIndex = readJournal(journalPath);
  } catch {
    console.warn(`[canon] cliff-event-sweep: failed to read journal at ${journalPath}`);
    return 0;
  }

  if (stepIndex === null) {
    console.warn(`[canon] cliff-event-sweep: journal at ${journalPath} is malformed — skipping`);
    return 0;
  }

  let updated = 0;
  for (const row of rows) {
    const journalStep = stepIndex.get(row.step_id);
    if (journalStep === undefined) continue;
    if (enrichRow({ journalStep, projectDir, row })) updated++;
  }
  return updated;
}

// ---- Recovery-outcome enrichment ----

function enrichOutcomes(projectDir: string): number {
  const cliffDao = getDriftDb(projectDir).getCliffEvents();
  const allRows = cliffDao.getAll();
  const needsEnrichment = allRows.filter(
    (r) => r.recovery_outcome === "unknown" || r.recovery_outcome === "unresolved",
  );

  if (needsEnrichment.length === 0) return 0;

  // Group by workspace_slug — read each journal at most once
  const bySlug = new Map<string, typeof needsEnrichment>();
  for (const row of needsEnrichment) {
    const existing = bySlug.get(row.workspace_slug) ?? [];
    existing.push(row);
    bySlug.set(row.workspace_slug, existing);
  }

  let updated = 0;
  for (const [slug, rows] of bySlug) {
    try {
      updated += enrichSlug(slug, rows, projectDir);
    } catch (err) {
      console.warn(
        `[canon] cliff-event-sweep: enrichment failed for ${slug}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return updated;
}

// ---- Workspace enumeration ----

function enumerateWorkspaceDbs(workspacesRoot: string): Array<{ dbPath: string; slug: string }> {
  let branchDirs: string[] = [];
  try {
    branchDirs = readdirSync(workspacesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const result: Array<{ dbPath: string; slug: string }> = [];
  for (const branchDir of branchDirs) {
    const branchPath = join(workspacesRoot, branchDir);
    let slugDirs: string[] = [];
    try {
      slugDirs = readdirSync(branchPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const slug of slugDirs) {
      const dbPath = join(branchPath, slug, "orchestration.db");
      if (existsSync(dbPath)) {
        result.push({ dbPath, slug: basename(slug) });
      }
    }
  }
  return result;
}

// ---- Public API ----

/**
 * Fail-open sweep: never throws; returns a SweepResult on all paths
 * (empty result + warn on catastrophic failure).
 *
 * Algorithm:
 * 1. Enumerate projectDir/.canon/workspaces/[branch]/[slug]/orchestration.db.
 * 2. For each DB: open read-only, extract cliff_detected events, upsert into drift.db.
 * 3. Enrich recovery_outcome from journal.json for rows still "unknown"/"unresolved".
 */
export function sweepCliffEvents(projectDir: string): SweepResult {
  const result: SweepResult = {
    events_ingested: 0,
    outcomes_updated: 0,
    scanned_workspaces: 0,
    skipped: [],
  };

  try {
    const workspacesRoot = join(projectDir, ".canon", "workspaces");
    const workspaces = enumerateWorkspaceDbs(workspacesRoot);

    for (const { dbPath, slug } of workspaces) {
      result.scanned_workspaces++;
      try {
        result.events_ingested += ingestWorkspaceDb(dbPath, slug, projectDir);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.skipped.push({ path: dbPath, reason });
        console.warn(`[canon] cliff-event-sweep: failed to process ${dbPath}:`, reason);
      }
    }

    try {
      result.outcomes_updated = enrichOutcomes(projectDir);
    } catch (err) {
      console.warn(
        "[canon] cliff-event-sweep: outcome enrichment failed:",
        err instanceof Error ? err.message : err,
      );
    }
  } catch (err) {
    console.warn(
      "[canon] cliff-event-sweep: catastrophic failure:",
      err instanceof Error ? err.message : err,
    );
  }

  return result;
}
