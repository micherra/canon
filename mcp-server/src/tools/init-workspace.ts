/**
 * MCP tool wrapper for workspace initialization.
 * Creates a new workspace directory structure or resumes an existing one.
 */

import {
  sanitizeBranch,
  generateSlug,
  checkSlugCollision,
  initWorkspace as createWorkspace,
} from "../orchestration/workspace.ts";
import { initBoard } from "../orchestration/board.ts";
import { loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import type { Board, Session } from "../orchestration/flow-schema.ts";
import { BoardSchema, SessionSchema } from "../orchestration/flow-schema.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { z } from "zod";
import { readFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { spawnSync } from "child_process";

interface InitWorkspaceInput {
  flow_name: string;
  task: string;
  branch: string;
  base_commit: string;
  tier: "small" | "medium" | "large";
  original_input?: string;
  skip_flags?: string[];
  preflight?: boolean;
}

interface InitWorkspaceResult {
  workspace: string;
  slug: string;
  board: Board;
  session: Session;
  created: boolean;
  resume_state?: string;
  preflight_issues?: string[];
}

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
  const results: Array<{ workspace: string; session: Session; board: Board; resume_state: string }> = [];

  let entries: string[];
  try {
    const { readdir } = await import("fs/promises");
    entries = await readdir(branchDir);
  } catch (err: any) {
    if (err.code === "ENOENT") return results;
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
      results.push({ workspace: ws, session, board, resume_state: board.current_state });
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
  candidateWorkspace: string,
): Promise<string[]> {
  const issues: string[] = [];

  // 1. Check for uncommitted changes
  try {
    const result = spawnSync("git", ["status", "--porcelain"], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const output = (result.stdout ?? "").trim();
    if (output) {
      const lineCount = output.split("\n").length;
      issues.push(`Uncommitted changes: ${lineCount} file(s) modified`);
    }
  } catch {
    // git not available — skip this check
  }

  // 2. Check for existing lock on candidate workspace
  try {
    const lockPath = join(candidateWorkspace, ".lock");
    await access(lockPath);
    const raw = await readFile(lockPath, "utf-8");
    const lock = JSON.parse(raw) as { pid: number; started: string };
    const age = Date.now() - new Date(lock.started).getTime();
    if (age < FOUR_HOURS_MS) {
      issues.push(`Active lock on workspace (pid ${lock.pid}, started ${lock.started})`);
    }
  } catch {
    // No lock file or unreadable — clean
  }

  // 3. Check for stale sessions on the same branch
  try {
    const active = await listBranchWorkspaces(projectDir, branch);
    for (const ws of active) {
      const lockExists = await access(join(ws.workspace, ".lock")).then(() => true, () => false);
      const sessionAge = Date.now() - new Date(ws.session.created).getTime();
      if (!lockExists && sessionAge > FOUR_HOURS_MS) {
        issues.push(`Stale session: "${ws.session.task}" (created ${ws.session.created}, no lock)`);
      }
    }
  } catch {
    // Scan failure — skip
  }

  return issues;
}

export async function initWorkspaceFlow(
  input: InitWorkspaceInput,
  projectDir: string,
  pluginDir: string,
): Promise<InitWorkspaceResult> {
  const sanitized = sanitizeBranch(input.branch);

  // Generate slug early — workspace path is scoped by branch + slug
  const baseSlug = generateSlug(input.task);

  // Pre-flight checks (advisory — run before any mutations)
  if (input.preflight) {
    const branchDirPf = join(projectDir, ".canon", "workspaces", sanitized);
    const candidateWs = join(branchDirPf, baseSlug);
    const issues = await runPreflightChecks(projectDir, input.branch, candidateWs);
    if (issues.length > 0) {
      // Return early with issues — no workspace created
      return {
        workspace: candidateWs,
        slug: baseSlug,
        board: {} as Board,
        session: {} as Session,
        created: false,
        preflight_issues: issues,
      };
    }
  }

  // Check for existing workspace with matching slug (resume case)
  const branchDir = join(projectDir, ".canon", "workspaces", sanitized);
  const candidateSlug = baseSlug;
  const candidateWorkspace = join(branchDir, candidateSlug);

  try {
    const store = getExecutionStore(candidateWorkspace);
    const session = store.getSession();
    const board = store.getBoard();

    // Only resume if the session is active
    if (session && session.status === "active" && board) {
      return {
        workspace: candidateWorkspace,
        slug: session.slug,
        board,
        session,
        created: false,
        resume_state: board.current_state,
      };
    }
  } catch {
    // No existing workspace for this slug — proceed with creation
  }

  // Workspace path: .canon/workspaces/{branch}/{slug}/
  const slug = await checkSlugCollision(branchDir, baseSlug);
  const workspace = join(branchDir, slug);

  // Create workspace directory structure
  await createWorkspace(projectDir, join(sanitized, slug));

  // Re-check for existing execution inside (another process may have created it)
  const store = getExecutionStore(workspace);
  const existingSession = store.getSession();
  if (existingSession && existingSession.status === "active") {
    const existingBoard = store.getBoard()!;
    return { workspace, slug: existingSession.slug, board: existingBoard, session: existingSession, created: false, resume_state: existingBoard.current_state };
  }

  // Load and resolve flow
  const { flow } = await loadAndResolveFlow(pluginDir, input.flow_name);

  // Create plans/${slug}/ directory
  await mkdir(join(workspace, "plans", slug), { recursive: true });

  // Init board from resolved flow
  const board = initBoard(flow, input.task, input.base_commit);

  // Create session object
  const now = new Date().toISOString();
  const session: Session = {
    branch: input.branch,
    sanitized,
    created: now,
    task: input.task,
    original_task: input.original_input,
    tier: input.tier,
    flow: input.flow_name,
    slug,
    status: "active",
  };

  // Persist execution to SQLite
  store.initExecution({
    flow: board.flow,
    task: board.task,
    entry: board.entry,
    current_state: board.current_state,
    base_commit: board.base_commit,
    started: board.started,
    last_updated: board.last_updated,
    branch: session.branch,
    sanitized: session.sanitized,
    created: session.created,
    original_task: session.original_task,
    tier: session.tier,
    flow_name: session.flow,
    slug: session.slug,
    status: session.status,
  });

  // Persist initial state records
  for (const [stateId] of Object.entries(flow.states)) {
    store.upsertState(stateId, { status: "pending", entries: 0 });
    const stateDef = flow.states[stateId];
    if (stateDef.max_iterations !== undefined) {
      store.upsertIteration(stateId, { count: 0, max: stateDef.max_iterations, history: [], cannot_fix: [] });
    }
  }

  // Seed progress
  store.appendProgress(`## Progress: ${input.task}`);

  return { workspace, slug, board, session, created: true };
}
