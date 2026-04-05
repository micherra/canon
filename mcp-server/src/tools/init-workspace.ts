/**
 * MCP tool wrapper for workspace initialization.
 * Creates a new workspace directory structure or resumes an existing one.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gitStatus, gitWorktreeAdd } from "../platform/adapters/git-adapter.ts";
import { CANON_DIR, CANON_FILES } from "../shared/constants.ts";
import { KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { initBoard } from "../orchestration/board.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import type { Board, Session } from "../orchestration/flow-schema.ts";
import {
  checkSlugCollision,
  initWorkspace as createWorkspace,
  generateSlug,
  sanitizeBranch,
} from "../orchestration/workspace.ts";

type InitWorkspaceInput = {
  flow_name: string;
  task: string;
  branch: string;
  base_commit: string;
  tier: "small" | "medium" | "large";
  original_input?: string;
  skip_flags?: string[];
  preflight?: boolean;
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
};

/**
 * List active workspaces for a branch. Scans all task subdirectories under
 * the branch workspace directory and returns sessions with status "active".
 */
export async function listBranchWorkspaces(
  projectDir: string,
  branch: string,
): Promise<Array<{ workspace: string; session: Session; board: Board; resume_state: string }>> {
  const sanitized = sanitizeBranch(branch);
  const branchDir = join(projectDir, ".canon", "workspaces", sanitized);
  const results: Array<{
    workspace: string;
    session: Session;
    board: Board;
    resume_state: string;
  }> = [];

  let entries: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(branchDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return results;
    throw err;
  }

  for (const entry of entries) {
    const ws = join(branchDir, entry);
    try {
      const store = getExecutionStore(ws);
      const session = store.getSession();
      if (!session) continue;
      if (session.status !== "active") continue;
      const board = store.getBoard();
      if (!board) continue;
      results.push({ board, resume_state: board.current_state, session, workspace: ws });
    } catch {
      // Not a valid workspace subdirectory — skip
    }
  }

  return results;
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/**
 * Run pre-flight checks: git status, lock, and stale sessions.
 * Returns an array of issue descriptions (empty if clean).
 */
async function runPreflightChecks(
  projectDir: string,
  branch: string,
  _candidateWorkspace: string,
): Promise<string[]> {
  const issues: string[] = [];

  // 1. Check for uncommitted changes
  try {
    const result = gitStatus(projectDir, 10_000);
    const output = result.stdout.trim();
    if (output) {
      const lineCount = output.split("\n").length;
      issues.push(`Uncommitted changes: ${lineCount} file(s) modified`);
    }
  } catch {
    // git not available — skip this check
  }

  // 2. Check for stale sessions on the same branch
  try {
    const active = await listBranchWorkspaces(projectDir, branch);
    for (const ws of active) {
      const sessionAge = Date.now() - new Date(ws.session.created).getTime();
      if (sessionAge > FOUR_HOURS_MS) {
        issues.push(`Stale session: "${ws.session.task}" (created ${ws.session.created})`);
      }
    }
  } catch {
    // Scan failure — skip
  }

  return issues;
}

/** Check if an error is an expected "no existing DB" error. */
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

/** Check if an error is a UNIQUE constraint error from concurrent insertion. */
function isSqliteConstraintError(err: unknown): boolean {
  return (
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    (err as { code?: string }).code === "SQLITE_CONSTRAINT" ||
    (err instanceof Error && err.message.includes("UNIQUE constraint"))
  );
}

/** Try to resume an existing workspace. Returns result if resume succeeds, null otherwise. */
function tryResumeWorkspace(
  candidateWorkspace: string,
  projectDir: string,
): InitWorkspaceResult | null {
  try {
    const store = getExecutionStore(candidateWorkspace);
    const session = store.getSession();
    const board = store.getBoard();
    if (session && session.status === "active" && board) {
      const worktreePath = join(projectDir, ".canon", "worktrees", session.slug);
      const worktreeExists = existsSync(worktreePath);
      return {
        board,
        created: false,
        resume_state: board.current_state,
        session,
        slug: session.slug,
        workspace: candidateWorkspace,
        worktree_branch: worktreeExists ? `canon-build/${session.slug}` : undefined,
        worktree_path: worktreeExists ? worktreePath : undefined,
      };
    }
  } catch (err) {
    if (!isExpectedNoDbError(err)) throw err;
  }
  return null;
}

/** Persist initial state and iteration records to the execution store. */
function persistInitialStates(
  store: ReturnType<typeof getExecutionStore>,
  flow: Awaited<ReturnType<typeof loadAndResolveFlow>>,
): void {
  for (const [stateId] of Object.entries(flow.states)) {
    store.upsertState(stateId, { entries: 0, status: "pending" });
    const stateDef = flow.states[stateId];
    const maxIter = stateDef.max_revisions ?? stateDef.max_iterations;
    if (maxIter !== undefined) {
      store.upsertIteration(stateId, { cannot_fix: [], count: 0, history: [], max: maxIter });
    } else if (stateDef.approval_gate === true && stateDef.type !== "terminal") {
      store.upsertIteration(stateId, { cannot_fix: [], count: 0, history: [], max: 3 });
    }
  }
}

/** Find the top N hub files by in-degree. */
function findTopHubs(
  allDegrees: Map<number, { in_degree: number; out_degree: number }>,
  fileIdToPath: Map<number, string>,
  n: number,
): Array<{ path: string; in_degree: number }> {
  const entries: Array<{ path: string; in_degree: number }> = [];
  for (const [fileId, degrees] of allDegrees) {
    const path = fileIdToPath.get(fileId);
    if (path !== undefined && degrees.in_degree > 0)
      entries.push({ in_degree: degrees.in_degree, path });
  }
  entries.sort((a, b) => b.in_degree - a.in_degree);
  return entries.slice(0, n);
}

/** Generate the project structure section from the KG database. */
function generateProjectStructure(projectDir: string): string | null {
  const kgDbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(kgDbPath)) return null;

  const db = initDatabase(kgDbPath);
  try {
    const kgQuery = new KgQuery(db);
    const allFiles = kgQuery.getAllFilesWithStats();

    const layerCounts = new Map<string, number>();
    const fileIdToPath = new Map<number, string>();
    for (const file of allFiles) {
      if (file.file_id !== undefined) fileIdToPath.set(file.file_id, file.path);
      const layer = file.layer || "unknown";
      layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
    }

    const layerBreakdown = [...layerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([layer, count]) => `${layer} (${count} file${count === 1 ? "" : "s"})`)
      .join(", ");

    const top5 = findTopHubs(kgQuery.getAllFileDegrees(), fileIdToPath, 5);

    const hubLine =
      top5.length > 0
        ? `Hub files (high in-degree): ${top5.map((h) => `${h.path} (${h.in_degree})`).join(", ")}`
        : "Hub files (high in-degree): none";

    return [
      "## Project Structure",
      "",
      `Layers: ${layerBreakdown || "none"}`,
      hubLine,
      `Total files in graph: ${allFiles.length}`,
    ].join("\n");
  } finally {
    db.close();
  }
}

/** Options for building the cache prefix. */
type BuildCachePrefixOptions = {
  slug: string;
  flow: Awaited<ReturnType<typeof loadAndResolveFlow>>;
  projectDir: string;
  pluginDir: string;
};

/** Build the shared prompt cache prefix. */
async function buildCachePrefix(
  input: InitWorkspaceInput,
  options: BuildCachePrefixOptions,
): Promise<string> {
  const { slug, flow, projectDir, pluginDir } = options;
  const prefixParts: string[] = [];
  if (flow.description) prefixParts.push(`## Flow: ${flow.name}\n\n${flow.description}`);

  const claudeMdPath = join(pluginDir, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    try {
      prefixParts.push(await readFile(claudeMdPath, "utf-8"));
    } catch {
      /* graceful */
    }
  }

  prefixParts.push(
    `## Workspace\n\n- Task: ${input.task}\n- Branch: ${input.branch}\n- Slug: ${slug}\n- Base commit: ${input.base_commit}`,
  );

  try {
    const structure = generateProjectStructure(projectDir);
    if (structure) prefixParts.push(structure);
  } catch {
    /* graceful */
  }

  try {
    const conventionsPath = join(projectDir, CANON_DIR, "CONVENTIONS.md");
    if (existsSync(conventionsPath)) {
      prefixParts.push(`## Conventions\n\n${await readFile(conventionsPath, "utf-8")}`);
    }
  } catch {
    /* graceful */
  }

  return prefixParts.join("\n\n---\n\n");
}

/** Options for creating and persisting a worktree. */
type CreateWorktreeOptions = {
  slug: string;
  baseCommit: string;
  projectDir: string;
};

/** Create worktree and persist info. Returns path and branch if successful. */
function createAndPersistWorktree(
  store: ReturnType<typeof getExecutionStore>,
  session: Session,
  options: CreateWorktreeOptions,
): { worktree_path?: string; worktree_branch?: string } {
  const { slug, baseCommit, projectDir } = options;
  const worktreePath = join(projectDir, ".canon", "worktrees", slug);
  const worktreeBranch = `canon-build/${slug}`;
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

/** Options for finalizing a new workspace. */
type FinalizeWorkspaceOptions = {
  workspace: string;
  slug: string;
  board: Board;
  session: Session;
  flow: Awaited<ReturnType<typeof loadAndResolveFlow>>;
  projectDir: string;
  pluginDir: string;
};

/** Persist execution, set up cache prefix, worktree, and return final result. */
async function finalizeNewWorkspace(
  store: ReturnType<typeof getExecutionStore>,
  input: InitWorkspaceInput,
  options: FinalizeWorkspaceOptions,
): Promise<InitWorkspaceResult> {
  const { workspace, slug, board, session, flow, projectDir, pluginDir } = options;
  const raceResult = initExecutionOrRace(store, board, session, workspace);
  if (raceResult) return raceResult;

  persistInitialStates(store, flow);

  const cachePrefix = await buildCachePrefix(input, { flow, pluginDir, projectDir, slug });
  store.setCachePrefix(cachePrefix);
  const prefixHash = createHash("sha256").update(cachePrefix).digest("hex").slice(0, 12);
  store.appendProgress(`## Progress: ${input.task}`);

  const worktreeInfo = createAndPersistWorktree(store, session, {
    baseCommit: input.base_commit,
    projectDir,
    slug,
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

  const resumeResult = tryResumeWorkspace(candidateWorkspace, projectDir);
  if (resumeResult) return resumeResult;

  const slug = await checkSlugCollision(branchDir, baseSlug);
  const workspace = join(branchDir, slug);
  await createWorkspace(projectDir, join(sanitized, slug));

  const store = getExecutionStore(workspace);
  const existingSession = store.getSession();
  if (existingSession && existingSession.status === "active") {
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

  const flow = await loadAndResolveFlow(pluginDir, input.flow_name);
  await mkdir(join(workspace, "plans", slug), { recursive: true });
  const board = initBoard(flow, input.task, input.base_commit);

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

  return finalizeNewWorkspace(store, input, {
    board,
    flow,
    pluginDir,
    projectDir,
    session,
    slug,
    workspace,
  });
}
