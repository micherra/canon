/**
 * decisions-corpus — offline cross-workspace decisions reader + aggregator (ADR-0040).
 *
 * Composes two partitions into one deterministically-sorted, source-tagged
 * corpus:
 *   - **live**: every workspace still on disk under `.canon/workspaces/**`,
 *     read raw via `readDecisionEvents` (shared with the janitor's reap-time
 *     persist path — schema-skew tolerant, never throws).
 *   - **durable**: workspaces already reaped, whose decisions were mirrored
 *     into drift.db's `orchestrator_decisions` table before deletion.
 *
 * A workspace is either live-on-disk OR reaped-and-persisted, never both —
 * persist only fires immediately before the janitor's `rmSync` (ADR-0040) —
 * so the union below is dedup-free by construction.
 *
 * Canon principles:
 * - command-query-separation: pure query, no mutation.
 * - deep-modules: `buildDecisionsCorpus(projectDir)` is a one-arg interface
 *   over the two-partition walk.
 * - no-silent-failures: unreadable live stores surface in `skipped[]`
 *   (observable), never silently dropped with zero trace.
 */

import { globSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type { PersistedDecision } from "@platform/storage/drift/orchestrator-decisions-dao.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { type DecisionRecord, readDecisionEvents } from "@shared/lib/decision-event-reader.ts";
import Database from "better-sqlite3";

// ── Types ────────────────────────────────────────────────────────────────────

/** A decision record tagged with which partition it came from. */
export type CorpusDecision = DecisionRecord & {
  source: "live" | "durable";
  source_slug: string;
};

/** A live store that could not be opened/read at all. */
export type SkippedStore = { path: string; reason: string };

/** Pure aggregation over a corpus of decisions. */
export type Aggregation = {
  total: number;
  by_category: Record<string, number>;
  by_decision_type: Record<string, number>;
  by_outcome: Record<string, number>;
  fill_rates: { rationale: number; outcome: number; gate: number; refs: number };
};

/** Result of a corpus build: the unioned decisions plus any unreadable stores. */
export type DecisionsCorpus = { decisions: CorpusDecision[]; skipped: SkippedStore[] };

// ── Helpers ───────────────────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Probe whether a sqlite file can be opened readonly at all. Distinct from
 * `readDecisionEvents`'s row-level fail-open — this catches "obviously
 * unreadable" stores (missing file, not a sqlite file, corrupt header) so
 * they can be surfaced in `skipped[]` rather than silently contributing zero
 * decisions with no trace (no-silent-failures).
 */
function tryOpenReadonly(dbPath: string): string | null {
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { fileMustExist: true, readonly: true });
    // better-sqlite3 opens lazily — a non-sqlite file only fails on first
    // access. A cheap `PRAGMA` probes readability without touching `events`.
    db.pragma("schema_version");
    return null;
  } catch (err) {
    return errMessage(err);
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort close
    }
  }
}

/** Convert a durable PersistedDecision row to a CorpusDecision (source: "durable"). */
function persistedToCorpusDecision(row: PersistedDecision): CorpusDecision {
  const record: CorpusDecision = {
    decided_at: row.decided_at,
    decision_type: row.decision_type,
    source: "durable",
    source_event_id: row.source_event_id,
    source_slug: row.source_slug,
    summary: row.summary,
  };
  if (row.rationale !== null) record.rationale = row.rationale;
  if (row.outcome !== null) record.outcome = row.outcome;
  if (row.gate !== null) record.gate = row.gate;
  if (row.refs.length > 0) record.refs = row.refs;
  return record;
}

/** Deterministic comparator: decided_at, then source_slug, then source_event_id. */
function compareDecisions(a: CorpusDecision, b: CorpusDecision): number {
  if (a.decided_at !== b.decided_at) return a.decided_at < b.decided_at ? -1 : 1;
  if (a.source_slug !== b.source_slug) return a.source_slug < b.source_slug ? -1 : 1;
  return a.source_event_id - b.source_event_id;
}

// ── Corpus build ──────────────────────────────────────────────────────────────

/**
 * Build the unioned, source-tagged, deterministically-sorted decisions corpus
 * for a project. Never throws — every partition degrades independently
 * (fail-open), surfacing unreadable live stores in `skipped[]`.
 */
export function buildDecisionsCorpus(projectDir: string): DecisionsCorpus {
  const decisions: CorpusDecision[] = [];
  const skipped: SkippedStore[] = [];

  // Live partition: glob every on-disk workspace's orchestration.db.
  const workspacesDir = join(projectDir, CANON_DIR, "workspaces");
  let dbPaths: string[] = [];
  try {
    dbPaths = globSync(`**/${CANON_FILES.ORCHESTRATION_DB}`, { cwd: workspacesDir });
  } catch (err) {
    skipped.push({ path: workspacesDir, reason: `glob failed: ${errMessage(err)}` });
  }

  for (const relPath of dbPaths) {
    const dbPath = join(workspacesDir, relPath);
    const openError = tryOpenReadonly(dbPath);
    if (openError !== null) {
      skipped.push({ path: dbPath, reason: openError });
      continue;
    }
    const sourceSlug = basename(dirname(dbPath));
    for (const record of readDecisionEvents(dbPath)) {
      decisions.push({ ...record, source: "live", source_slug: sourceSlug });
    }
  }

  // Durable partition: reaped workspaces already mirrored into drift.db.
  try {
    const durable = getDriftDb(projectDir).getOrchestratorDecisions().getAll();
    for (const row of durable) {
      decisions.push(persistedToCorpusDecision(row));
    }
  } catch (err) {
    skipped.push({
      path: join(projectDir, CANON_DIR, "drift.db"),
      reason: `durable read failed: ${errMessage(err)}`,
    });
  }

  decisions.sort(compareDecisions);
  return { decisions, skipped };
}

// ── Aggregation ───────────────────────────────────────────────────────────────

/** Bump `key` in `rec` by 1, initializing to 0 if absent. */
function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

/**
 * Count records by effective category, decision type, and outcome.
 *
 * `by_category` keys on the **effective category** — `gate ?? decision_type`
 * — so `plan_approval` and `review_verdict` surface as first-class buckets
 * instead of collapsing into an undifferentiated `hitl_gate` bucket (dc-03).
 */
function computeCategoryCounts(records: CorpusDecision[]): {
  by_category: Record<string, number>;
  by_decision_type: Record<string, number>;
  by_outcome: Record<string, number>;
} {
  const by_category: Record<string, number> = {};
  const by_decision_type: Record<string, number> = {};
  const by_outcome: Record<string, number> = {};

  for (const record of records) {
    bump(by_category, record.gate ?? record.decision_type);
    bump(by_decision_type, record.decision_type);
    bump(by_outcome, record.outcome ?? "(none)");
  }

  return { by_category, by_decision_type, by_outcome };
}

/** Fraction of records with a non-empty rationale/outcome/gate/refs field. */
function computeFillRates(records: CorpusDecision[]): Aggregation["fill_rates"] {
  const total = records.length;
  const rate = (predicate: (r: CorpusDecision) => boolean): number =>
    total === 0 ? 0 : records.filter(predicate).length / total;

  return {
    gate: rate((r) => r.gate !== undefined),
    outcome: rate((r) => r.outcome !== undefined),
    rationale: rate((r) => r.rationale !== undefined),
    refs: rate((r) => r.refs !== undefined && r.refs.length > 0),
  };
}

/**
 * Compute counts and fill-rates over a decisions corpus. PURE — no I/O.
 */
export function aggregateDecisions(records: CorpusDecision[]): Aggregation {
  return {
    ...computeCategoryCounts(records),
    fill_rates: computeFillRates(records),
    total: records.length,
  };
}

// ── Render ────────────────────────────────────────────────────────────────────

/** Escape backslashes and pipe characters in a markdown table cell value. */
function escapePipe(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Truncate a string to at most `max` chars, appending "..." if truncated. */
function truncate(s: string, max = 60): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

/** Sort a Record's entries by key for deterministic rendering. */
function sortedEntries(rec: Record<string, number>): Array<[string, number]> {
  return Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function renderCountList(rec: Record<string, number>): string {
  const entries = sortedEntries(rec);
  if (entries.length === 0) return "_none_";
  return entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
}

function renderAggregationSummary(aggregation: Aggregation): string {
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  return [
    `**Total decisions:** ${aggregation.total}`,
    "",
    "**By category (gate ?? decision_type):**",
    renderCountList(aggregation.by_category),
    "",
    "**By decision type:**",
    renderCountList(aggregation.by_decision_type),
    "",
    "**By outcome:**",
    renderCountList(aggregation.by_outcome),
    "",
    "**Fill rates:**",
    `- rationale: ${pct(aggregation.fill_rates.rationale)}`,
    `- outcome: ${pct(aggregation.fill_rates.outcome)}`,
    `- gate: ${pct(aggregation.fill_rates.gate)}`,
    `- refs: ${pct(aggregation.fill_rates.refs)}`,
  ].join("\n");
}

function renderDecisionsTable(records: CorpusDecision[]): string {
  if (records.length === 0) return "_No decisions in corpus._";

  const header = "| Source | Slug | Decided At | Type | Gate | Summary | Outcome |";
  const sep = "|--------|------|------------|------|------|---------|---------|";

  const rows = records.map((r) => {
    const time = r.decided_at ? r.decided_at.replace("T", " ").slice(0, 16) : "-";
    const summary = escapePipe(truncate(r.summary));
    const outcome = escapePipe(r.outcome ?? "-");
    const gate = escapePipe(r.gate ?? "-");
    return `| ${r.source} | ${r.source_slug} | ${time} | ${r.decision_type} | ${gate} | ${summary} | ${outcome} |`;
  });

  return [header, sep, ...rows].join("\n");
}

/**
 * Render a decisions corpus + its aggregation as a human-readable markdown
 * document. PURE — render is separated from I/O (deep-modules).
 */
export function renderCorpus(records: CorpusDecision[], aggregation: Aggregation): string {
  return `${renderAggregationSummary(aggregation)}\n\n${renderDecisionsTable(records)}`;
}
