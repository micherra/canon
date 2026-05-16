/**
 * MCP tool wrapper for workspace initialization.
 * Creates a new workspace directory structure or resumes an existing one.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { CANON_DIR } from "@shared/constants.ts";
import { seedFromPriorWorkspace } from "./seed-workspace.ts";

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
    if (!session || session.status !== "active") return null;
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
 * Try to resume an existing workspace. Returns result if resume succeeds, null otherwise.
 *
 * Task-identity invariant: when `expectedTask` is provided, the stored session's task
 * must match exactly. If it does not match, returns `null` (no resume) — this prevents
 * a truncated slug collision from resuming the wrong workspace. The generateSlug function
 * truncates long task strings to 72 characters, which can produce identical slugs for
 * distinct tasks; the guard here is the defense-in-depth layer against that failure mode.
 *
 * @param candidateWorkspace - Absolute path to the candidate workspace directory
 * @param projectDir - Absolute path to the project root
 * @param expectedTask - When provided, resume is blocked if `session.task !== expectedTask`
 */
function tryResumeWorkspace(
  candidateWorkspace: string,
  projectDir: string,
  expectedTask?: string,
): InitWorkspaceResult | null {
  try {
    const store = getExecutionStore(candidateWorkspace);
    const session = store.getSession();
    const board = store.getBoard();
    if (session && session.status === "active" && board) {
      if (expectedTask !== undefined && session.task !== expectedTask) return null;
      const worktreePath = resolveWorktreePath(candidateWorkspace, projectDir, session);
      const worktreeExists = existsSync(worktreePath);
      return {
        board,
        created: false,
        resume_state: board.current_state,
        session,
        slug: session.slug,
        workspace: candidateWorkspace,
        worktree_branch: worktreeExists
          ? (session.worktree_branch ?? `canon/${session.slug}`)
          : undefined,
        worktree_path: worktreeExists ? worktreePath : undefined,
      };
    }
  } catch (err) {
    if (!isExpectedNoDbError(err)) throw err;
  }
  return null;
}

async function tryReadFileContent(path: string, label: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    console.warn(`[canon] ${label} read failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Build the shared prompt cache prefix. */
async function buildCachePrefix(
  input: InitWorkspaceInput,
  options: {
    slug: string;
    flowName?: string;
    projectDir: string;
    pluginDir: string;
  },
): Promise<string> {
  const { slug, flowName, projectDir, pluginDir } = options;
  const prefixParts: string[] = [];
  prefixParts.push(`## Flow: ${flowName ?? input.flow_name}`);

  const claudeMd = await tryReadFileContent(join(pluginDir, "CLAUDE.md"), "cache prefix CLAUDE.md");
  if (claudeMd) prefixParts.push(claudeMd);

  prefixParts.push(
    `## Workspace\n\n- Task: ${input.task}\n- Branch: ${input.branch}\n- Slug: ${slug}\n- Base commit: ${input.base_commit}`,
  );

  const conventions = await tryReadFileContent(
    join(projectDir, CANON_DIR, "CONVENTIONS.md"),
    "conventions",
  );
  if (conventions) prefixParts.push(`## Conventions\n\n${conventions}`);

  return prefixParts.join("\n\n---\n\n");
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
  workspace: string,
  result: InitWorkspaceResult,
): Promise<void> {
  if (input.seed_from) {
    const seedResult = await seedFromPriorWorkspace(input.seed_from, workspace);
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

/** Create a brand-new workspace (no collision, no resume). */
async function createNewWorkspace(opts: CreateNewWorkspaceOptions): Promise<InitWorkspaceResult> {
  const { input, branchDir, sanitized, baseSlug, projectDir, pluginDir } = opts;
  const slug = await checkSlugCollision(branchDir, baseSlug);
  const workspace = join(branchDir, slug);
  await createWorkspace(projectDir, join(sanitized, slug));

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

  const board = initBoard(input.flow_name, input.task, input.base_commit);

  await mkdir(join(workspace, "plans", slug), { recursive: true });
  if (input.runbook_content) {
    await writeFile(join(workspace, "plans", slug, "runbook.md"), input.runbook_content);
  }
  if (input.brief_content) {
    await writeFile(join(workspace, "plans", slug, "planning-brief.md"), input.brief_content);
  }
  const now = new Date().toISOString();
  const session: Session = {
    branch: input.branch,
    created: now,
    flow: input.flow_name,
    original_task: input.original_input,
    sanitized,
    slug,
    status: "active",
    task: input.task,
    tier: input.tier,
  };

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

  const resumeResult = tryResumeWorkspace(candidateWorkspace, projectDir, input.task);
  if (resumeResult) return resumeResult;

  const result = await createNewWorkspace({
    baseSlug,
    branchDir,
    input,
    pluginDir,
    projectDir,
    sanitized,
  });
  await applyPostCreateSteps(input, result.workspace, result);
  return result;
}
