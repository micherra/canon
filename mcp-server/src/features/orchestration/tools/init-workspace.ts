/**
 * MCP tool wrapper for workspace initialization.
 * Creates a new workspace directory structure or resumes an existing one.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initBoard } from "@domains/board/board.ts";
import type { Board, Session } from "@domains/flows/board-state-schemas.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import {
  checkSlugCollision,
  initWorkspace as createWorkspace,
  generateSlug,
  sanitizeBranch,
} from "@domains/workspaces/workspace.ts";
import { gitStatus, gitWorktreeAdd } from "@platform/adapters/git-adapter.ts";
import { registerFromInit } from "../services/active-workspace-registration.ts";
import { buildCachePrefix } from "../services/cache-prefix-builder.ts";
import { acquireLock } from "../services/workspace-lock.ts";
import { readJournal, writeJournal } from "./orchestration-journal.ts";
import { validateSeedPath } from "./seed-workspace.ts";

type InitWorkspaceInput = {
  flow_name: string;
  task: string;
  branch: string;
  base_commit: string;
  tier?: "small" | "medium" | "large";
  original_input?: string;
  skip_flags?: string[];
  preflight?: boolean;
  seed_from?: string;
  runbook_content?: string;
  brief_content?: string;
  /** Calling session's identity (CLAUDE_CODE_SESSION_ID) — passed explicitly since the
   * shared HTTP daemon cannot derive per-session identity from process.env (see PROBE-FINDINGS.md Probe 1). */
  session_id?: string;
  /** Job identifier — first 8 chars of basename(CLAUDE_JOB_DIR); stored in the workspace lock for audit. */
  job_id?: string;
};

type InitWorkspaceResult = {
  workspace: string;
  candidate_workspace?: string;
  slug: string;
  board: Board;
  session: Session;
  created: boolean;
  resume_state?: string;
  preflight_issues?: string[];
  worktree_path?: string;
  worktree_branch?: string;
  cache_prefix_hash?: string;
  seeded_from?: string;
  /**
   * Set to true when a live foreign lock exists on the workspace.
   * Callers must NOT proceed; present the lock_owner to the user via HITL.
   */
  lock_gated?: boolean;
  /**
   * The record of the session currently holding the lock.
   * Present when lock_gated is true.
   */
  lock_owner?: import("../services/workspace-lock.ts").LockRecord;
  /**
   * Set to "reclaimed" when init reclaimed a stale lock before proceeding.
   * Informational only — proceed normally.
   */
  lock_reclaimed?: "ttl" | "pid_dead" | "corrupt_and_stale";
};

/**
 * List active workspaces for a branch. Scans all task subdirectories under
 * the branch workspace directory and returns sessions with status "active".
 */
type BranchWorkspaceEntry = {
  workspace: string;
  session: Session;
  board: Board;
  resume_state: string;
};

function tryReadActiveWorkspace(ws: string): BranchWorkspaceEntry | null {
  try {
    const store = getExecutionStore(ws);
    const session = store.getSession();
    if (session?.status !== "active") return null;
    const board = store.getBoard();
    if (!board) return null;
    return { board, resume_state: board.current_state, session, workspace: ws };
  } catch (err) {
    console.warn("[canon] workspace scan skipped entry:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function listBranchWorkspaces(
  projectDir: string,
  branch: string,
): Promise<BranchWorkspaceEntry[]> {
  const sanitized = sanitizeBranch(branch);
  const branchDir = join(projectDir, ".canon", "workspaces", sanitized);

  let entries: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(branchDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const results: BranchWorkspaceEntry[] = [];
  for (const entry of entries) {
    const result = tryReadActiveWorkspace(join(branchDir, entry));
    if (result) results.push(result);
  }
  return results;
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

async function checkFileClaimsIssue(projectDir: string): Promise<string | null> {
  try {
    const { readClaims } = await import("@shared/lib/file-claims.ts");
    const claims = readClaims(projectDir);
    const totalClaimed = Object.keys(claims.claims).length;
    if (totalClaimed === 0) return null;
    const workflows = new Set<string>(
      Object.values(claims.claims).flatMap((entries) => entries.map((e) => e.workflow)),
    );
    return `Active file claims: ${totalClaimed} file(s) claimed by workflow(s): ${[...workflows].join(", ")}`;
  } catch (err) {
    console.warn("[canon] file claims check failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Run pre-flight checks. Returns issue descriptions (empty if clean). */
async function runPreflightChecks(
  projectDir: string,
  branch: string,
  _candidateWorkspace: string,
): Promise<string[]> {
  const issues: string[] = [];

  try {
    const result = gitStatus(projectDir, 10_000);
    const output = result.stdout.trim();
    if (output) issues.push(`Uncommitted changes: ${output.split("\n").length} file(s) modified`);
  } catch (err) {
    console.warn(
      "[canon] git status preflight check failed:",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    const active = await listBranchWorkspaces(projectDir, branch);
    for (const ws of active) {
      if (Date.now() - new Date(ws.session.created).getTime() > FOUR_HOURS_MS) {
        issues.push(`Stale session: "${ws.session.task}" (created ${ws.session.created})`);
      }
    }
  } catch (err) {
    console.warn("[canon] branch workspace scan failed:", err instanceof Error ? err.message : err);
  }

  const claimsIssue = await checkFileClaimsIssue(projectDir);
  if (claimsIssue) issues.push(claimsIssue);

  return issues;
}

/** Exported for testing — delegates to runPreflightChecks. */
export const runPreflightChecksForTest = runPreflightChecks;

function isExpectedNoDbError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === "SQLITE_CANTOPEN" ||
    code === "ENOENT" ||
    message.includes("SQLITE_CANTOPEN") ||
    message.includes("no such file") ||
    message.includes("directory does not exist") ||
    message.includes("Cannot open database")
  );
}

function isSqliteConstraintError(err: unknown): boolean {
  return (
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    (err as { code?: string }).code === "SQLITE_CONSTRAINT" ||
    (err instanceof Error && err.message.includes("UNIQUE constraint"))
  );
}

/**
 * Attempt to acquire the workspace mutex for `workspace`.
 *
 * Returns `null` on success (acquired or reclaimed — caller proceeds).
 * Returns a gated `InitWorkspaceResult` when a live foreign lock exists.
 *
 * Acquire is best-effort: any unexpected error is warned and treated as proceed
 * (fail-open for the lock acquisition itself, not the fail-safe posture of the lock
 * content — D7 fail-safe applies inside acquireLock, not here).
 */
function tryAcquireWorkspaceLock(
  workspace: string,
  input: Pick<InitWorkspaceInput, "session_id" | "job_id">,
  slug: string,
): InitWorkspaceResult | null {
  try {
    const outcome = acquireLock(workspace, {
      job_id: input.job_id,
      session_id: input.session_id,
    });
    if (outcome.kind === "gated") {
      // Foreign session owns this workspace — return gated result
      return {
        board: {} as Board,
        created: false,
        lock_gated: true,
        lock_owner: outcome.owner,
        session: {} as Session,
        slug,
        workspace: "",
      };
    }
    // acquired or reclaimed — proceed; surface reclaim reason for log_decision
    return null;
  } catch (err) {
    console.warn(
      "[init-workspace] workspace lock acquire failed (proceeding):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Resolve the worktree path for a resumed session.
 * Priority: persisted path → new {workspace}/worktree → legacy .canon/worktrees/{slug}
 */
function resolveWorktreePath(
  candidateWorkspace: string,
  projectDir: string,
  session: { slug: string; worktree_path?: string },
): string {
  if (session.worktree_path) return session.worktree_path;
  const newPath = join(candidateWorkspace, "worktree");
  if (existsSync(newPath)) return newPath;
  const legacyPath = join(projectDir, ".canon", "worktrees", session.slug);
  if (existsSync(legacyPath)) return legacyPath;
  return newPath;
}
/**
 * Build the resume result for an active session. Pure — no side effects.
 * Resolves the worktree path and returns a complete InitWorkspaceResult.
 *
 * Separated from tryResumeWorkspace to reduce its cognitive complexity
 * (ternary expressions for worktree_branch and worktree_path are extracted
 * here so the caller stays under the noExcessiveCognitiveComplexity limit).
 */
function buildResumeResult(
  ws: string,
  projectDir: string,
  session: Session,
  board: Board,
): InitWorkspaceResult {
  const worktreePath = resolveWorktreePath(ws, projectDir, session);
  const worktreeExists = existsSync(worktreePath);
  return {
    board,
    created: false,
    resume_state: board.current_state,
    session,
    slug: session.slug,
    workspace: ws,
    worktree_branch: worktreeExists
      ? (session.worktree_branch ?? `canon/${session.slug}`)
      : undefined,
    worktree_path: worktreeExists ? worktreePath : undefined,
  };
}

/**
 * Try to resume an existing workspace. Returns result if resume succeeds, null otherwise.
 *
 * Task-identity invariant: when `expectedTask` is provided, the stored session's task
 * must match exactly. Returns `null` on mismatch — prevents truncated slug collisions
 * (generateSlug truncates at 72 chars; the guard here is the defense-in-depth layer).
 *
 * Lock invariant: acquires the workspace mutex before resuming. Returns a gated result
 * when a live foreign lock exists (orchestrator MUST present the gated state to user).
 */
function tryResumeWorkspace(
  candidateWorkspace: string,
  projectDir: string,
  expectedTask?: string,
  lockOwner?: { session_id?: string; job_id?: string },
): InitWorkspaceResult | null {
  try {
    const store = getExecutionStore(candidateWorkspace);
    const session = store.getSession();
    const board = store.getBoard();
    const taskMatches = expectedTask === undefined || session?.task === expectedTask;
    if (session && session.status === "active" && board && taskMatches) {
      const gated = tryAcquireWorkspaceLock(candidateWorkspace, lockOwner ?? {}, session.slug);
      if (gated) return gated;
      return buildResumeResult(candidateWorkspace, projectDir, session, board);
    }
  } catch (err) {
    if (!isExpectedNoDbError(err)) throw err;
  }
  return null;
}

/**
 * Best-effort: symlink the worktree's mcp-server/node_modules to the main checkout's
 * resolved mcp-server/node_modules so the agent LSP tool resolves zod/vitest/.ts imports.
 * Lives in gitignored .canon/** — never enters the package (see ADR-0011). Non-blocking:
 * on any failure the build proceeds (LSP degrades). Skips if main node_modules is absent
 * or a node_modules already exists at the link site.
 *
 * Guard 2 (non-circular): target is realpathSync(main node_modules), which resolves to
 * an absolute path outside the worktree subtree — never circular.
 */
export function linkWorktreeNodeModules(worktreePath: string, projectDir: string): void {
  try {
    const mainNm = join(projectDir, "mcp-server", "node_modules");
    if (!existsSync(mainNm)) return; // main deps not installed → no-op
    const target = realpathSync(mainNm); // resolved, outside the worktree → non-circular (Guard 2)
    const linkSite = join(worktreePath, "mcp-server", "node_modules");
    try {
      // lstatSync does not follow symlinks — check if anything already exists at link site
      lstatSync(linkSite);
      return; // already present → do not clobber
    } catch {
      // ENOENT — link site does not exist, safe to create
    }
    symlinkSync(target, linkSite, "dir");
  } catch (err) {
    console.warn(
      "[init-workspace] node_modules symlink skipped:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Build a unique session branch name for the build worktree. */
function buildSessionBranchName(session: Session): string {
  return `canon/${session.slug}`;
}

/** Create worktree and persist info. Returns path and branch if successful. */
function createAndPersistWorktree(
  store: ReturnType<typeof getExecutionStore>,
  session: Session,
  options: { workspace: string; baseCommit: string; projectDir: string },
): { worktree_path?: string; worktree_branch?: string } {
  const { workspace, baseCommit, projectDir } = options;
  const worktreePath = join(workspace, "worktree");
  const worktreeBranch = session.worktree_branch ?? buildSessionBranchName(session);
  const wtResult = gitWorktreeAdd(worktreePath, projectDir, {
    baseCommit,
    branchName: worktreeBranch,
  });
  if (!wtResult.ok) return {};
  linkWorktreeNodeModules(worktreePath, projectDir); // Guard 2 non-circular by construction

  session.worktree_path = worktreePath;
  session.worktree_branch = worktreeBranch;
  try {
    store.updateExecution({ worktree_branch: worktreeBranch, worktree_path: worktreePath });
  } catch (err) {
    console.warn("[init-workspace] Failed to persist worktree info to execution row:", err);
  }
  return { worktree_branch: worktreeBranch, worktree_path: worktreePath };
}

/** Initialize execution store, handling race conditions with concurrent initializers. */
function initExecutionOrRace(
  store: ReturnType<typeof getExecutionStore>,
  board: Board,
  session: Session,
  workspace: string,
): InitWorkspaceResult | null {
  try {
    store.initExecution({
      base_commit: board.base_commit,
      branch: session.branch,
      created: session.created,
      current_state: board.current_state,
      entry: board.entry,
      flow: board.flow,
      flow_name: session.flow,
      last_updated: board.last_updated,
      original_task: session.original_task,
      sanitized: session.sanitized,
      slug: session.slug,
      started: board.started,
      status: session.status,
      task: board.task,
      tier: session.tier,
    });
    return null;
  } catch (err) {
    if (!isSqliteConstraintError(err)) throw err;
    const winnerSession = store.getSession();
    if (winnerSession && winnerSession.status === "active") {
      const winnerBoard = store.getBoard()!;
      return {
        board: winnerBoard,
        created: false,
        resume_state: winnerBoard.current_state,
        session: winnerSession,
        slug: winnerSession.slug,
        workspace,
      };
    }
    throw err;
  }
}

/** Run preflight checks if requested. Returns early result or null to proceed. */
async function runPreflightIfNeeded(
  input: InitWorkspaceInput,
  projectDir: string,
  sanitized: string,
  baseSlug: string,
): Promise<InitWorkspaceResult | null> {
  if (!input.preflight) return null;
  const candidateWs = join(projectDir, ".canon", "workspaces", sanitized, baseSlug);
  const issues = await runPreflightChecks(projectDir, input.branch, candidateWs);
  if (issues.length === 0) return null;
  return {
    board: {} as Board,
    candidate_workspace: candidateWs,
    created: false,
    preflight_issues: issues,
    session: {} as Session,
    slug: baseSlug,
    workspace: "",
  };
}

type FinalizeWorkspaceOptions = {
  workspace: string;
  slug: string;
  board: Board;
  session: Session;
  projectDir: string;
  pluginDir: string;
};

/** Persist execution, set up cache prefix, worktree, and return final result. */
async function finalizeNewWorkspace(
  store: ReturnType<typeof getExecutionStore>,
  input: InitWorkspaceInput,
  options: FinalizeWorkspaceOptions,
): Promise<InitWorkspaceResult> {
  const { workspace, slug, board, session, projectDir, pluginDir } = options;
  const raceResult = initExecutionOrRace(store, board, session, workspace);
  if (raceResult) return raceResult;

  const cachePrefix = await buildCachePrefix(input, {
    flowName: input.flow_name,
    pluginDir,
    projectDir,
    slug,
  });
  store.setCachePrefix(cachePrefix);
  const prefixHash = createHash("sha256").update(cachePrefix).digest("hex").slice(0, 12);
  store.appendProgress(`## Progress: ${input.task}`);

  const worktreeInfo = createAndPersistWorktree(store, session, {
    baseCommit: input.base_commit,
    projectDir,
    workspace,
  });

  return {
    board,
    created: true,
    session,
    slug,
    workspace,
    ...worktreeInfo,
    cache_prefix_hash: prefixHash,
  };
}

/** Apply optional seed-from after workspace creation. */
async function applyPostCreateSteps(
  input: InitWorkspaceInput,
  _workspace: string,
  result: InitWorkspaceResult,
): Promise<void> {
  if (input.seed_from) {
    const seedResult = await validateSeedPath(input.seed_from);
    for (const warning of seedResult.warnings) {
      console.warn(`[init-workspace] ${warning}`);
    }
    if (seedResult.seeded) result.seeded_from = input.seed_from;
  }
}

type CreateNewWorkspaceOptions = {
  input: InitWorkspaceInput;
  branchDir: string;
  sanitized: string;
  baseSlug: string;
  projectDir: string;
  pluginDir: string;
};

/**
 * Seed plans/{slug}/ artifacts (runbook, planning brief) and journal.json for a
 * brand-new workspace. journal.json is seeded ONLY when `input.session_id` is
 * present (tail-gate-codex-fix P1) — the durable signal
 * hooks/tail-enforcement-gate.sh matches a Stop event's session_id against,
 * since it survives finalize_workspace's unconditional .lock release. Omitted
 * entirely otherwise (never write the literal "unknown").
 */
async function seedNewWorkspaceArtifacts(
  workspace: string,
  slug: string,
  input: InitWorkspaceInput,
): Promise<void> {
  await mkdir(join(workspace, "plans", slug), { recursive: true });
  if (input.runbook_content) {
    await writeFile(join(workspace, "plans", slug, "runbook.md"), input.runbook_content);
  }
  if (input.brief_content) {
    await writeFile(join(workspace, "plans", slug, "planning-brief.md"), input.brief_content);
  }
  if (input.session_id) {
    await writeJournal(workspace, {
      session_id: input.session_id,
      steps: [],
      version: 1,
      workspace,
    });
  }
}

/** Create a brand-new workspace (no collision, no resume). */
async function createNewWorkspace(opts: CreateNewWorkspaceOptions): Promise<InitWorkspaceResult> {
  const { input, branchDir, sanitized, baseSlug, projectDir, pluginDir } = opts;
  const slug = await checkSlugCollision(branchDir, baseSlug);
  const workspace = join(branchDir, slug);
  await createWorkspace(projectDir, join(sanitized, slug));

  // Acquire mutex AFTER workspace dir is created (lock lives at workspace root).
  // Robust to the known created-true-no-worktree quirk: lock guards the workspace
  // dir, not the worktree — so we always attempt the lock here even if the worktree
  // creation fails later.
  const board = initBoard(input.flow_name, input.task, input.base_commit);
  const session: Session = {
    branch: input.branch,
    created: new Date().toISOString(),
    flow: input.flow_name,
    original_task: input.original_input,
    sanitized,
    slug,
    status: "active",
    task: input.task,
    tier: input.tier,
  };
  const lockGated = tryAcquireWorkspaceLock(
    workspace,
    { job_id: input.job_id, session_id: input.session_id },
    slug,
  );
  if (lockGated) return lockGated;

  const store = getExecutionStore(workspace);
  const existingSession = store.getSession();
  if (existingSession?.status === "active") {
    const existingBoard = store.getBoard()!;
    return {
      board: existingBoard,
      created: false,
      resume_state: existingBoard.current_state,
      session: existingSession,
      slug: existingSession.slug,
      workspace,
    };
  }

  await seedNewWorkspaceArtifacts(workspace, slug, input);

  const result = await finalizeNewWorkspace(store, input, {
    board,
    pluginDir,
    projectDir,
    session,
    slug,
    workspace,
  });
  return result;
}

/**
 * Refresh journal.json's top-level session_id to the re-entering session
 * (tail-gate-codex-fix P1). Read-modify-write preserving `steps` — reuses the
 * existing readJournal/writeJournal pair, not a second journal writer. A
 * no-op when `sessionId` is absent (leave the existing value untouched) or
 * already current (skip the write).
 */
async function refreshJournalSessionId(
  workspace: string,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  const journal = await readJournal(workspace);
  if (journal.session_id === sessionId) return;
  journal.session_id = sessionId;
  await writeJournal(workspace, journal);
}

export async function initWorkspaceFlow(
  input: InitWorkspaceInput,
  projectDir: string,
  pluginDir: string,
): Promise<InitWorkspaceResult> {
  const sanitized = sanitizeBranch(input.branch);
  const baseSlug = generateSlug(input.task);

  const preflightResult = await runPreflightIfNeeded(input, projectDir, sanitized, baseSlug);
  if (preflightResult) return preflightResult;

  const branchDir = join(projectDir, ".canon", "workspaces", sanitized);
  const candidateWorkspace = join(branchDir, baseSlug);

  const resumeResult = tryResumeWorkspace(candidateWorkspace, projectDir, input.task, {
    job_id: input.job_id,
    session_id: input.session_id,
  });
  if (resumeResult) {
    // Gated results (lock_gated: true) carry no workspace to write to — a foreign
    // session owns this build, so we must not attribute it to the current caller.
    if (!resumeResult.lock_gated) {
      await refreshJournalSessionId(resumeResult.workspace, input.session_id);
    }
    registerFromInit(projectDir, input, resumeResult, resumeResult.session);
    return resumeResult;
  }

  const result = await createNewWorkspace({
    baseSlug,
    branchDir,
    input,
    pluginDir,
    projectDir,
    sanitized,
  });
  await applyPostCreateSteps(input, result.workspace, result);
  registerFromInit(projectDir, input, result, result.session);
  return result;
}
