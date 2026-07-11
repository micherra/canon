/**
 * `reconcile_learnings` MCP tool — reconcile-on-read primitive for the
 * learning-resolution flow (ADR-0048).
 *
 * Scans ONLY the timestamped-dir review surface (`.canon/proposed-learnings/{ts}/`
 * — never the loose top-level files, PROBE-FINDINGS P4). For each pending
 * ACTIONABLE proposal whose target resolves on disk AND a commit touching that
 * target post-dates the proposal (the evidence predicate, decision 0047),
 * moves the proposal to `applied/` and appends an accepted `learning.jsonl`
 * entry immediately after its own move (per-file interleaving — see
 * `moveAndAppend`). This bounds a mid-apply crash's unlogged-move window to
 * AT MOST the single proposal in flight when the crash lands — down from N
 * (the whole batch) under naive append-at-end-of-loop batching; the residual
 * one-file window (a crash between THIS proposal's own rename and its
 * append) is inherent to non-atomic filesystem operations and is not
 * eliminated. A commit that CREATED the target is sufficient evidence on
 * its own — including an OLDER creating commit even when a NEWER, unrelated
 * commit later churns the same file (the dedicated creation probe, not the
 * single most-recent-commit view, decides this); a commit that only
 * MODIFIED an already-existing target must
 * additionally reference the proposal (id or principle id) in its message —
 * an unrelated churn commit to the same file is not evidence. Also computes
 * freshness (decision `freshness-policy`): a stale, fully-informational set
 * auto-archives to `stale/`; a stale set with an actionable survivor is
 * flagged only.
 *
 * Tension (documented per `fail-closed-by-default` vs `observable-best-effort`):
 * safety gates fail CLOSED. This is an advisory quality mechanism, not a safety
 * gate, so it fails OPEN by design — any internal error is caught at the
 * handler boundary, logged via `console.warn`, and returned as a typed
 * `ToolResult` error. It never throws past this module and never blocks a
 * caller (the command treats a non-ok result as "reconcile unavailable,
 * proceed with the un-reconciled surface").
 */

import fs from "node:fs/promises";
import { join } from "node:path";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { isNotFound } from "@shared/lib/errors.ts";
import { isSafeProjectDirInput } from "@shared/lib/safe-project-dir.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { isPathContained } from "@shared/lib/worktree-guard.ts";
import { classifyProposal } from "./actionability.ts";

// ---------------------------------------------------------------------------
// Seams — injectable fs/git boundaries (interface-design-for-testability).
// Tests supply fakes; production wiring uses the default* implementations.
// ---------------------------------------------------------------------------

export type DirEntry = { name: string; isDirectory: boolean };

/** Filesystem operations reconcile needs, as an injectable seam. */
export type ReconcileFsSeam = {
  /** Lists directory entries; returns [] when the directory does not exist. */
  readDir(path: string): Promise<DirEntry[]>;
  /** Reads a file as utf-8 text; throws when the file does not exist. */
  readFile(path: string): Promise<string>;
  /** Returns true when a path exists on disk. */
  fileExists(path: string): Promise<boolean>;
  /** Recursively creates a directory; no-op if it already exists. */
  mkdir(path: string): Promise<void>;
  /** Moves a file — the ONLY relocation primitive reconcile uses (never a delete). */
  rename(from: string, to: string): Promise<void>;
  /** Appends text to a file, creating it if absent. Never rewrites existing content. */
  appendFile(path: string, data: string): Promise<void>;
};

/**
 * Evidence about the most recent commit satisfying the post-proposal-commit
 * predicate for a target path.
 */
export type CommitEvidence = {
  /** Short commit hash. */
  hash: string;
  /**
   * True when THIS commit's diff created `targetPath` (a genuine new-file
   * addition). File creation is sufficient evidence on its own — the
   * relevance check below only applies when this is false (the target
   * already existed and the commit only modified it).
   */
  createdFile: boolean;
  /** Commit subject + body — used for the content-linkage relevance check. */
  message: string;
};

/** Git operations reconcile needs, as an injectable seam. */
export type ReconcileGitSeam = {
  /**
   * Returns evidence for the most recent commit touching `targetPath` at or
   * after `sinceIso`, or null when no such commit exists. This is the base
   * evidence predicate: a proposal only reconciles when its target both
   * exists on disk AND has a commit that post-dates the proposal. Whether
   * that evidence is SUFFICIENT (creation vs. relevance-checked modification)
   * is decided by the caller — see `evaluateActionableProposal`.
   *
   * NOTE: this returns only the SINGLE most recent qualifying commit. A
   * target created by an older commit and later churned by an unrelated,
   * newer commit is reported here as the newer (non-creating) commit — see
   * `creationCommitSince` for the dedicated probe that recovers the older
   * creation evidence regardless of later churn.
   */
  latestCommitSince(
    projectDir: string,
    targetPath: string,
    sinceIso: string,
  ): CommitEvidence | null;
  /**
   * Dedicated creation probe: returns evidence for the most recent commit
   * that ADDED `targetPath` at or after `sinceIso`, or null when no such
   * creating commit exists in that window. Independent of
   * `latestCommitSince` — a target can have an older creating commit AND a
   * newer, unrelated modifying commit; `latestCommitSince` alone would only
   * ever see the newer one. Creation is sufficient evidence on its own
   * (decision 0047), so the caller checks this FIRST, before falling back to
   * `latestCommitSince`'s modify-plus-relevance path.
   */
  creationCommitSince(
    projectDir: string,
    targetPath: string,
    sinceIso: string,
  ): CommitEvidence | null;
};

async function readDirDefault(path: string): Promise<DirEntry[]> {
  try {
    const entries = await fs.readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ isDirectory: e.isDirectory(), name: e.name }));
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

async function fileExistsDefault(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** Default fs seam — real filesystem via node:fs/promises. */
export const defaultFsSeam: ReconcileFsSeam = {
  appendFile: (path, data) => fs.appendFile(path, data, "utf-8"),
  fileExists: fileExistsDefault,
  mkdir: (path) => fs.mkdir(path, { recursive: true }).then(() => undefined),
  readDir: readDirDefault,
  readFile: (path) => fs.readFile(path, "utf-8"),
  rename: (from, to) => fs.rename(from, to),
};

/** Default git seam — real `git log`/`git show` via the shared git adapter. */
export const defaultGitSeam: ReconcileGitSeam = {
  creationCommitSince(projectDir, targetPath, sinceIso) {
    // `--diff-filter=A` restricts git log to commits that ADDED targetPath —
    // this finds the creating commit directly, regardless of how many later
    // commits touched the file since.
    const result = gitExec(
      [
        "log",
        "--since",
        sinceIso,
        "--diff-filter=A",
        "-n",
        "1",
        "--format=%h%x00%B",
        "--",
        targetPath,
      ],
      projectDir,
    );
    if (!result.ok) return null;
    const raw = result.stdout.trim();
    if (raw.length === 0) return null;

    const sep = raw.indexOf("\0");
    const hash = sep === -1 ? raw : raw.slice(0, sep);
    const message = sep === -1 ? "" : raw.slice(sep + 1).trim();

    return { createdFile: true, hash, message };
  },

  latestCommitSince(projectDir, targetPath, sinceIso) {
    const result = gitExec(
      ["log", "--since", sinceIso, "-n", "1", "--format=%h%x00%B", "--", targetPath],
      projectDir,
    );
    if (!result.ok) return null;
    const raw = result.stdout.trim();
    if (raw.length === 0) return null;

    const sep = raw.indexOf("\0");
    const hash = sep === -1 ? raw : raw.slice(0, sep);
    const message = sep === -1 ? "" : raw.slice(sep + 1).trim();

    // Was targetPath ADDED (not just modified) by this specific commit?
    const statusResult = gitExec(
      ["show", "--format=", "--name-status", hash, "--", targetPath],
      projectDir,
    );
    const createdFile = statusResult.ok && /^A\s/m.test(statusResult.stdout.trim());

    return { createdFile, hash, message };
  },
};

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export type ReconcileLearningsInput = {
  project_dir: string;
  freshness_days?: number;
  dry_run?: boolean;
};

export type ReconciledItem = {
  file: string;
  dir: string;
  target_path: string;
  commit: string;
  reason: string;
};

export type ArchivedItem = {
  file: string;
  dir: string;
  age_days: number;
};

export type FlaggedSet = {
  dir: string;
  age_days: number;
  actionable_survivors: string[];
};

export type SkippedItem = {
  file: string;
  reason: string;
};

export type ReconcileLearningsOutput = {
  reconciled: ReconciledItem[];
  archived: ArchivedItem[];
  flagged_stale: FlaggedSet[];
  skipped: SkippedItem[];
};

/** Documented default staleness window (decision `freshness-policy`). Overridable per call. */
export const FRESHNESS_DAYS = 30;

const PRINCIPLE_SUBDIRS = ["rules", "strong-opinions", "conventions"] as const;
const PRINCIPLE_BASES = ["principles", ".canon/principles"] as const;
const TS_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

/** Converts a proposal-dir timestamp (`2026-05-29T22-00-00Z`) into a real ISO instant. */
function dirTimestampToIso(tsDir: string): string {
  return tsDir.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
}

const FULL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/** True for a full `YYYY-MM-DDTHH:MM:SS` timestamp (optional fraction/offset). */
function isFullTimestamp(value: string): boolean {
  return FULL_TIMESTAMP_PATTERN.test(value);
}

/**
 * Resolves the proposal's real instant for the evidence-predicate `--since`
 * bound. A date-only frontmatter `created` (e.g. `2026-05-29`) collapses to
 * an implicit midnight when handed to `git log --since`, which can falsely
 * count a same-day-earlier commit as post-dating an evening proposal — so
 * date-only values fall back to the full-precision dir-timestamp instead. A
 * `created` value that already carries a time component is used verbatim —
 * but only when it is actually a recognized full timestamp shape. A
 * malformed value (e.g. `created: soon`) is neither date-only nor a full
 * timestamp; handing it to `git log --since` verbatim would let git's
 * approxidate parser silently mis-parse it, so it falls back to the
 * full-precision dir-timestamp too, the same as the date-only case.
 */
function resolveProposalDateIso(raw: string, tsDir: string): string {
  const created = extractYamlField(raw, "created");
  if (created && isFullTimestamp(created)) return created;
  return dirTimestampToIso(tsDir);
}

function ageDaysFor(tsDir: string): number {
  const then = new Date(dirTimestampToIso(tsDir)).getTime();
  return Math.floor((Date.now() - then) / 86_400_000);
}

/** Extracts a single `field: value` YAML-style line (quoted or unquoted) from raw file text. */
function extractYamlField(text: string, field: string): string | null {
  const re = new RegExp(`^${field}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m");
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

/**
 * Resolves a proposal's target path: `target_path` -> `target_file` -> (`target`
 * as a principle id -> first existing of `principles/**\/<id>.md`,
 * `.canon/principles/**\/<id>.md`). Returns null when nothing resolves — the
 * proposal is left pending (conservative, PROBE-FINDINGS P6).
 */
async function resolveTargetPath(
  fsSeam: ReconcileFsSeam,
  projectDir: string,
  raw: string,
): Promise<string | null> {
  const targetPath = extractYamlField(raw, "target_path");
  if (targetPath) return targetPath;

  const targetFile = extractYamlField(raw, "target_file");
  if (targetFile) return targetFile;

  const target = extractYamlField(raw, "target");
  if (target) {
    for (const base of PRINCIPLE_BASES) {
      for (const subdir of PRINCIPLE_SUBDIRS) {
        const candidate = `${base}/${subdir}/${target}.md`;
        if (await fsSeam.fileExists(join(projectDir, candidate))) return candidate;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plan / apply — read-only planning is fully separated from mutation so a
// thrown error during planning can never leave a partial mutation behind.
// ---------------------------------------------------------------------------

type PlannedReconcile = {
  tsDir: string;
  file: string;
  targetPath: string;
  commit: string;
  reason: string;
};

type PlannedArchive = {
  tsDir: string;
  file: string;
  ageDays: number;
};

type Plan = {
  reconcileActions: PlannedReconcile[];
  archiveActions: PlannedArchive[];
  flagged: FlaggedSet[];
  skipped: SkippedItem[];
};

/** Bundles the injected seams + project root so per-proposal helpers stay under the max-params lint. */
type ReconcileContext = {
  fs: ReconcileFsSeam;
  git: ReconcileGitSeam;
  projectDir: string;
};

/** Result of evaluating one actionable pending proposal against the evidence predicate. */
type ProposalOutcome =
  | { kind: "reconcile"; action: PlannedReconcile }
  | { kind: "survivor"; skip: SkippedItem };

/**
 * Conservative content-linkage check for a MODIFIED (pre-existing) target: a
 * commit that only touched an already-existing file is evidence only when
 * its message references the proposal's own id or the target's principle id
 * (its filename without extension). File-creation is sufficient evidence on
 * its own and never reaches this check — see `evaluateActionableProposal`.
 */
function isRelevantCommit(message: string, proposalId: string | null, targetPath: string): boolean {
  const principleId = targetPath.split("/").pop()?.replace(/\.md$/, "") ?? null;
  const needles = [proposalId, principleId].filter((v): v is string => Boolean(v));
  return needles.some((needle) => message.includes(needle));
}

/**
 * Evaluates a single actionable proposal: resolves its target, re-contains it
 * under `project_dir` (a resolved `target_path` that escapes via `..`
 * segments is treated as unresolved — path-traversal existence-oracle guard),
 * then checks the evidence predicate (target exists on disk AND a commit
 * touching it post-dates the proposal).
 *
 * The creation probe runs FIRST: a commit that CREATED the target — however
 * long ago, as long as it post-dates the proposal — is sufficient evidence on
 * its own, regardless of any later, unrelated commit that also touched the
 * file (the `-n 1`-most-recent-commit view alone would miss this: it only
 * ever sees the newest qualifying commit, which may be an unrelated churn
 * commit that post-dates the real creation). Only when no creation commit is
 * found does evaluation fall back to the most-recent-commit view: a target
 * the commit only MODIFIED (it already existed) additionally requires the
 * commit to reference the proposal — an unrelated churn commit is not
 * evidence. Returns either a planned reconcile action or a "survivor"
 * outcome (stays pending, with the reason it didn't reconcile).
 */
async function evaluateActionableProposal(
  ctx: ReconcileContext,
  tsDir: string,
  file: string,
  raw: string,
): Promise<ProposalOutcome> {
  const survivor = (reason: string): ProposalOutcome => ({
    kind: "survivor",
    skip: { file: `${tsDir}/${file}`, reason },
  });

  const targetPath = await resolveTargetPath(ctx.fs, ctx.projectDir, raw);
  if (targetPath === null) return survivor("no resolvable target path");

  const resolvedAbsPath = join(ctx.projectDir, targetPath);
  if (!isPathContained(ctx.projectDir, resolvedAbsPath)) {
    return survivor(`resolved target path escapes project_dir: ${targetPath}`);
  }

  const exists = await ctx.fs.fileExists(resolvedAbsPath);
  if (!exists) return survivor(`target does not exist on disk: ${targetPath}`);

  const proposalDateIso = resolveProposalDateIso(raw, tsDir);

  const creationEvidence = ctx.git.creationCommitSince(ctx.projectDir, targetPath, proposalDateIso);
  if (creationEvidence !== null) {
    return {
      action: {
        commit: creationEvidence.hash,
        file,
        reason: `reconciled: ${targetPath} created in ${creationEvidence.hash}`,
        targetPath,
        tsDir,
      },
      kind: "reconcile",
    };
  }

  const evidence = ctx.git.latestCommitSince(ctx.projectDir, targetPath, proposalDateIso);
  if (evidence === null) {
    return survivor(`no commit touching ${targetPath} post-dates the proposal`);
  }

  if (!evidence.createdFile) {
    const proposalId = extractYamlField(raw, "id");
    if (!isRelevantCommit(evidence.message, proposalId, targetPath)) {
      return survivor(
        `commit ${evidence.hash} touches ${targetPath} but does not reference the proposal — no content-linkage evidence`,
      );
    }
  }

  return {
    action: {
      commit: evidence.hash,
      file,
      reason: `reconciled: ${targetPath} shipped in ${evidence.hash}`,
      targetPath,
      tsDir,
    },
    kind: "reconcile",
  };
}

/** Result of classifying + evaluating every pending file in one timestamped dir. */
type EvaluatedDir = {
  pendingFiles: string[];
  reconcileActions: PlannedReconcile[];
  reconciledFiles: Set<string>;
  survivors: string[];
  skipped: SkippedItem[];
};

/** Classifies and evaluates every pending `.md` file directly inside one timestamped dir. */
async function evaluatePendingFiles(
  ctx: ReconcileContext,
  tsDir: string,
  pendingFiles: string[],
): Promise<EvaluatedDir> {
  const tsDirPath = join(ctx.projectDir, ".canon", "proposed-learnings", tsDir);
  const reconcileActions: PlannedReconcile[] = [];
  const skipped: SkippedItem[] = [];
  const survivors: string[] = [];
  const reconciledFiles = new Set<string>();

  for (const file of pendingFiles) {
    const raw = await ctx.fs.readFile(join(tsDirPath, file));
    const classification = classifyProposal({ filename: file, frontmatter: raw });
    if (classification.actionability === "informational") continue; // never reconciled

    const outcome = await evaluateActionableProposal(ctx, tsDir, file, raw);
    if (outcome.kind === "reconcile") {
      reconciledFiles.add(file);
      reconcileActions.push(outcome.action);
    } else {
      survivors.push(file);
      skipped.push(outcome.skip);
    }
  }

  return { pendingFiles, reconcileActions, reconciledFiles, skipped, survivors };
}

/** Freshness decision for one timestamped dir (decision `freshness-policy`). */
type FreshnessDecision = { archiveActions: PlannedArchive[]; flagged: FlaggedSet | null };

/**
 * Applies the freshness decision to an evaluated dir: a stale (age >
 * freshnessDays) informational-only set (zero actionable survivors)
 * auto-archives every remaining pending file; a stale set with an actionable
 * survivor is flagged only, never archived.
 */
function decideFreshness(
  tsDir: string,
  evaluated: EvaluatedDir,
  freshnessDays: number,
): FreshnessDecision {
  const ageDays = ageDaysFor(tsDir);
  if (ageDays <= freshnessDays) return { archiveActions: [], flagged: null };

  if (evaluated.survivors.length > 0) {
    return {
      archiveActions: [],
      flagged: { actionable_survivors: evaluated.survivors, age_days: ageDays, dir: tsDir },
    };
  }

  const archiveActions = evaluated.pendingFiles
    .filter((file) => !evaluated.reconciledFiles.has(file))
    .map((file) => ({ ageDays, file, tsDir }));
  return { archiveActions, flagged: null };
}

/** Per-timestamp-dir plan contribution — reconcile/archive actions plus at most one flag. */
type TsDirPlan = {
  reconcileActions: PlannedReconcile[];
  archiveActions: PlannedArchive[];
  flagged: FlaggedSet | null;
  skipped: SkippedItem[];
};

/**
 * Plans one timestamped dir: classifies each pending `.md` file, evaluates
 * actionable ones against the evidence predicate, then applies the freshness
 * decision.
 */
async function planTimestampDir(
  ctx: ReconcileContext,
  tsDir: string,
  freshnessDays: number,
): Promise<TsDirPlan> {
  const tsDirPath = join(ctx.projectDir, ".canon", "proposed-learnings", tsDir);
  const dirEntries = await ctx.fs.readDir(tsDirPath);
  // Pending = a .md file directly in the ts dir. Once resolved, a proposal
  // lives under a resolution subdir (applied/rejected/dismissed/stale) and is
  // naturally excluded here — this is what fixes the P1 dir-level bug (the
  // old computation checked subdir *existence*, not per-file state).
  const pendingFiles = dirEntries
    .filter((e) => !e.isDirectory && e.name.endsWith(".md"))
    .map((e) => e.name);

  const evaluated = await evaluatePendingFiles(ctx, tsDir, pendingFiles);
  const { archiveActions, flagged } = decideFreshness(tsDir, evaluated, freshnessDays);

  return {
    archiveActions,
    flagged,
    reconcileActions: evaluated.reconcileActions,
    skipped: evaluated.skipped,
  };
}

async function buildPlan(
  fsSeam: ReconcileFsSeam,
  gitSeam: ReconcileGitSeam,
  projectDir: string,
  freshnessDays: number,
): Promise<Plan> {
  const ctx: ReconcileContext = { fs: fsSeam, git: gitSeam, projectDir };
  const root = join(projectDir, ".canon", "proposed-learnings");
  const rootEntries = await ctx.fs.readDir(root);
  const tsDirs = rootEntries
    .filter((e) => e.isDirectory && TS_DIR_PATTERN.test(e.name))
    .map((e) => e.name);

  const plan: Plan = { archiveActions: [], flagged: [], reconcileActions: [], skipped: [] };
  for (const tsDir of tsDirs) {
    const dirPlan = await planTimestampDir(ctx, tsDir, freshnessDays);
    plan.reconcileActions.push(...dirPlan.reconcileActions);
    plan.archiveActions.push(...dirPlan.archiveActions);
    plan.skipped.push(...dirPlan.skipped);
    if (dirPlan.flagged) plan.flagged.push(dirPlan.flagged);
  }

  return plan;
}

function planToOutput(plan: Plan): ReconcileLearningsOutput {
  return {
    archived: plan.archiveActions.map((a) => ({ age_days: a.ageDays, dir: a.tsDir, file: a.file })),
    flagged_stale: plan.flagged,
    reconciled: plan.reconcileActions.map((a) => ({
      commit: a.commit,
      dir: a.tsDir,
      file: a.file,
      reason: a.reason,
      target_path: a.targetPath,
    })),
    skipped: plan.skipped,
  };
}

/** Serializes one `learning.jsonl` line. Append-only — never used to rewrite the file. */
function jsonlLine(entry: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
}

/** Bundles the fs seam + jsonl path so `moveAndAppend` stays under the max-params lint. */
type ApplyContext = { fs: ReconcileFsSeam; jsonlPath: string };

/**
 * Moves one file into a resolution subdir and appends its audit line
 * IMMEDIATELY afterward (per-file interleaving, not batched at the end).
 * This bounds the unlogged-move window to AT MOST one in-flight proposal
 * (`explicit-transaction-boundaries`): a crash between THIS proposal's own
 * rename and its append still leaves that one file moved-but-unlogged — that
 * residual single-file window is inherent to non-atomic filesystem
 * operations and is not eliminated — but a crash before or after this call
 * cannot orphan any OTHER proposal's audit line the way end-of-loop batching
 * would (where a single crash could leave the ENTIRE batch's moves
 * unlogged). Rename-then-append (not append-then-rename) keeps retries
 * idempotency-safe: a retry re-enumerates only files still pending, so
 * append-first would risk a duplicate audit line for the same move on
 * retry.
 */
async function moveAndAppend(
  ctx: ApplyContext,
  from: string,
  to: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await ctx.fs.rename(from, to);
  await ctx.fs.appendFile(ctx.jsonlPath, `${jsonlLine(entry)}\n`);
}

async function applyPlan(
  fsSeam: ReconcileFsSeam,
  projectDir: string,
  freshnessDays: number,
  plan: Plan,
): Promise<void> {
  const root = join(projectDir, ".canon", "proposed-learnings");
  const ctx: ApplyContext = { fs: fsSeam, jsonlPath: join(projectDir, ".canon", "learning.jsonl") };

  for (const action of plan.reconcileActions) {
    const tsDirPath = join(root, action.tsDir);
    const appliedDir = join(tsDirPath, "applied");
    await fsSeam.mkdir(appliedDir);
    await moveAndAppend(ctx, join(tsDirPath, action.file), join(appliedDir, action.file), {
      action: "accepted",
      commit: action.commit,
      proposal_id: action.file,
      reason: action.reason,
      target_path: action.targetPath,
    });
  }

  for (const action of plan.archiveActions) {
    const tsDirPath = join(root, action.tsDir);
    const staleDir = join(tsDirPath, "stale");
    await fsSeam.mkdir(staleDir);
    await moveAndAppend(ctx, join(tsDirPath, action.file), join(staleDir, action.file), {
      action: "archived",
      age_days: action.ageDays,
      proposal_id: action.file,
      reason: `stale > ${freshnessDays}d, informational-only`,
    });
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Reconciles the `.canon/proposed-learnings/{ts}/` review surface: auto-moves
 * shipped actionable proposals to `applied/`, and auto-archives stale
 * informational-only sets to `stale/`. Idempotent, fail-open, append-only,
 * move-never-delete.
 *
 * Validates `project_dir`/`freshness_days` at this seam before any filesystem
 * walk (`validate-at-trust-boundaries`). Any internal error — a thrown seam
 * call, a malformed proposal, anything unexpected — is caught here and
 * returned as a typed error; it never throws past this function.
 */
export async function reconcileLearnings(
  input: ReconcileLearningsInput,
  seams: { fs: ReconcileFsSeam; git: ReconcileGitSeam } = {
    fs: defaultFsSeam,
    git: defaultGitSeam,
  },
): Promise<ToolResult<ReconcileLearningsOutput>> {
  if (!isSafeProjectDirInput(input.project_dir)) {
    return toolError("INVALID_INPUT", `Invalid project_dir: ${input.project_dir}`, false);
  }

  const freshnessDays = input.freshness_days ?? FRESHNESS_DAYS;
  if (!Number.isFinite(freshnessDays) || freshnessDays <= 0) {
    return toolError(
      "INVALID_INPUT",
      `Invalid freshness_days: ${String(input.freshness_days)} — must be a positive number`,
      false,
    );
  }

  try {
    const plan = await buildPlan(seams.fs, seams.git, input.project_dir, freshnessDays);
    if (input.dry_run !== true) {
      await applyPlan(seams.fs, input.project_dir, freshnessDays, plan);
    }
    return toolOk(planToOutput(plan));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[reconcile-learnings] fail-open: reconcile aborted — ${detail}`);
    return toolError(
      "UNEXPECTED",
      `reconcile_learnings failed, proceeding with un-reconciled surface: ${detail}`,
      true,
    );
  }
}
