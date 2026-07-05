/**
 * MCP tool wrapper for forecast_base_advance.
 *
 * Plan-time exogenous-collision forecast: intersects a build's declared files with what has
 * landed (and is co-changing) on origin/main since base_commit, so the orchestrator can surface
 * a one-line advisory at plan-approval — before dispatch, not after a collision.
 *
 * Mirrors compute-autonomy-tier.ts's shape: a pure compute core + a thin I/O handler.
 *
 * Advisory-only, read-only at compute time: the handler never fetches and never writes.
 * Fail-safe: any git/KG error returns a silent result — never throws, never blocks the caller.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureGitIntelFresh } from "@features/knowledge-graph/git-intel/git-intel-pipeline.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";

// ---- Types ----

export type BaseAdvanceOverlap = {
  /** A declared file that overlaps main churn. */
  file: string;
  reason: "direct" | "co-change";
  /** co-change only: the main-changed file it co-changes with. */
  partner?: string;
  /** co-change only. */
  jaccard?: number;
};

export type ForecastBaseAdvanceResult = {
  commits_ahead: number;
  overlapping_files: BaseAdvanceOverlap[];
  advisory: string | null;
};

export type ForecastBaseAdvanceInput = {
  workspace: string;
  declared_files: string[];
  base_commit: string;
  /** Project directory — threaded from resolveScope(extra) in register-confidence-tools.ts. */
  projectDir: string;
};

/** A main-changed file's co-change partners, from the co_change_edges table. */
type CoChangePartner = { partner: string; jaccard: number };

// Silent, fail-safe result — used whenever main hasn't advanced, there's no overlap,
// or any git/KG error prevents computing a real answer.
const SILENT_RESULT: ForecastBaseAdvanceResult = {
  advisory: null,
  commits_ahead: 0,
  overlapping_files: [],
};

const MAX_ADVISORY_FILE_NAMES = 6;

// ---- Pure core ----

/** Declared files that were changed directly on origin/main. */
function findDirectOverlaps(
  declaredFiles: string[],
  mainChangedSet: Set<string>,
): BaseAdvanceOverlap[] {
  const direct: BaseAdvanceOverlap[] = [];
  for (const file of declaredFiles) {
    if (mainChangedSet.has(file)) direct.push({ file, reason: "direct" });
  }
  return direct;
}

/** Records a candidate co-change overlap, keeping the highest jaccard on a repeat file. */
function keepHighestJaccard(
  byFile: Map<string, BaseAdvanceOverlap>,
  candidate: BaseAdvanceOverlap,
): void {
  const existing = byFile.get(candidate.file);
  if (existing && (existing.jaccard ?? -1) >= (candidate.jaccard ?? -1)) return;
  byFile.set(candidate.file, candidate);
}

/**
 * Declared files that are a co-change partner of some main-changed file, excluding files
 * already captured as direct overlaps. Dedups by file, keeping the highest jaccard.
 */
function findCoChangeOverlaps(params: {
  mainChangedFiles: string[];
  declaredSet: Set<string>;
  directFiles: Set<string>;
  coPartners: Map<string, CoChangePartner[]>;
}): BaseAdvanceOverlap[] {
  const { mainChangedFiles, declaredSet, directFiles, coPartners } = params;
  const byFile = new Map<string, BaseAdvanceOverlap>();

  for (const mainChangedFile of mainChangedFiles) {
    const partners = coPartners.get(mainChangedFile) ?? [];
    for (const { partner, jaccard } of partners) {
      if (!declaredSet.has(partner) || directFiles.has(partner)) continue;
      keepHighestJaccard(byFile, {
        file: partner,
        jaccard,
        partner: mainChangedFile,
        reason: "co-change",
      });
    }
  }

  return [...byFile.values()];
}

/** One-liner naming the commit count and overlapping files, capped at MAX_ADVISORY_FILE_NAMES. */
function buildAdvisory(commitsAhead: number, overlappingFiles: BaseAdvanceOverlap[]): string {
  const names = overlappingFiles.map((o) => o.file);
  const shown = names.slice(0, MAX_ADVISORY_FILE_NAMES).join(", ");
  const remainder = names.length - MAX_ADVISORY_FILE_NAMES;
  const nameList = remainder > 0 ? `${shown}, +${remainder} more` : shown;
  return `${commitsAhead} commit(s) landed on origin/main since base; ${overlappingFiles.length} declared file(s) overlap recent/co-changing main churn (${nameList}) — expect a re-merge.`;
}

/**
 * Compute the base-advance forecast from already-gathered git + KG signals.
 *
 * Pure — no I/O. Silent (`advisory: null`) when `commitsAhead === 0` or there is no overlap
 * between `declaredFiles` and (`mainChangedFiles` ∪ their co-change partners).
 */
export function computeBaseAdvanceForecast(params: {
  commitsAhead: number;
  mainChangedFiles: string[];
  declaredFiles: string[];
  /** Co-change partners keyed by main-changed file. */
  coPartners: Map<string, CoChangePartner[]>;
}): ForecastBaseAdvanceResult {
  const { commitsAhead, mainChangedFiles, declaredFiles, coPartners } = params;

  if (commitsAhead === 0) return SILENT_RESULT;

  const declaredSet = new Set(declaredFiles);
  const mainChangedSet = new Set(mainChangedFiles);

  const direct = findDirectOverlaps(declaredFiles, mainChangedSet);
  const directFiles = new Set(direct.map((o) => o.file));
  const coChange = findCoChangeOverlaps({ coPartners, declaredSet, directFiles, mainChangedFiles });

  const overlapping_files = [...direct, ...coChange];
  if (overlapping_files.length === 0) return { ...SILENT_RESULT, commits_ahead: commitsAhead };

  return {
    advisory: buildAdvisory(commitsAhead, overlapping_files),
    commits_ahead: commitsAhead,
    overlapping_files,
  };
}

// ---- I/O gathering (handler) ----

/** Parse `git rev-list --count` stdout; returns 0 on any non-numeric or failed result. */
function parseCommitsAhead(stdout: string): number {
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseChangedFiles(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Query co_change_edges for a main-changed file's partners (both directions of the edge). */
function queryCoChangePartners(
  db: ReturnType<typeof initDatabase>,
  mainChangedFiles: string[],
): Map<string, CoChangePartner[]> {
  const coPartners = new Map<string, CoChangePartner[]>();
  const stmt = db.prepare(
    `SELECT file_b AS partner, jaccard FROM co_change_edges WHERE file_a = ?
     UNION
     SELECT file_a AS partner, jaccard FROM co_change_edges WHERE file_b = ?`,
  );
  for (const file of mainChangedFiles) {
    const partners = stmt.all(file, file) as CoChangePartner[];
    if (partners.length > 0) coPartners.set(file, partners);
  }
  return coPartners;
}

/**
 * Gather git + KG signals for a build and compute the base-advance forecast.
 *
 * Read-only: runs only `git rev-list`/`git diff` (no fetch) and KG reads. Never throws — any
 * error bubbles up to the caller's try/catch, which returns the silent fail-safe result.
 */
function gatherAndCompute(input: ForecastBaseAdvanceInput): ForecastBaseAdvanceResult {
  const { base_commit, declared_files, projectDir } = input;

  const revListResult = gitExec(["rev-list", `${base_commit}..origin/main`, "--count"], projectDir);
  if (!revListResult.ok) return SILENT_RESULT;
  const commitsAhead = parseCommitsAhead(revListResult.stdout);
  if (commitsAhead === 0) return SILENT_RESULT;

  const diffResult = gitExec(["diff", "--name-only", `${base_commit}..origin/main`], projectDir);
  if (!diffResult.ok) return SILENT_RESULT;
  const mainChangedFiles = parseChangedFiles(diffResult.stdout);

  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  let coPartners = new Map<string, CoChangePartner[]>();
  if (existsSync(dbPath)) {
    const db = initDatabase(dbPath);
    try {
      ensureGitIntelFresh(db, projectDir);
      coPartners = queryCoChangePartners(db, mainChangedFiles);
    } finally {
      db.close();
    }
  }

  return computeBaseAdvanceForecast({
    commitsAhead,
    coPartners,
    declaredFiles: declared_files,
    mainChangedFiles,
  });
}

/**
 * Forecast a plan-time exogenous-collision: intersect a build's declared files with what has
 * landed (and is co-changing) on origin/main since base_commit.
 *
 * Advisory-only — never blocks, never throws. Fail-safe: any git/KG error returns a silent
 * result (`{ commits_ahead: 0, overlapping_files: [], advisory: null }`).
 */
export async function forecastBaseAdvance(
  input: ForecastBaseAdvanceInput,
): Promise<ToolResult<ForecastBaseAdvanceResult>> {
  try {
    return toolOk(gatherAndCompute(input));
  } catch (err) {
    console.warn(
      "[canon] forecast-base-advance: signal gathering failed, returning silent result:",
      err instanceof Error ? err.message : err,
    );
    return toolOk(SILENT_RESULT);
  }
}
