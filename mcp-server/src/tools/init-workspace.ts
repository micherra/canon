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
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { existsSync } from "fs";
import { mkdir, readFile } from "fs/promises";
import { join } from "path";
import { createHash } from "node:crypto";
import { gitStatus, gitWorktreeAdd } from "../adapters/git-adapter.ts";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";

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
      // Return early with issues — no workspace created.
      // Use candidate_workspace (not workspace) so callers can't accidentally
      // pass a non-existent path to enter_and_prepare_state.
      return {
        workspace: "",
        candidate_workspace: candidateWs,
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
      const worktreePath = join(projectDir, ".canon", "worktrees", session.slug);
      const worktreeExists = existsSync(worktreePath);
      return {
        workspace: candidateWorkspace,
        slug: session.slug,
        board,
        session,
        created: false,
        resume_state: board.current_state,
        worktree_path: worktreeExists ? worktreePath : undefined,
        worktree_branch: worktreeExists ? `canon-build/${session.slug}` : undefined,
      };
    }
  } catch (err) {
    // Only swallow expected "no existing DB" errors (file not found / can't open).
    // Rethrow unexpected errors such as permission denied or disk errors.
    const code = (err as NodeJS.ErrnoException).code;
    const message = (err instanceof Error) ? err.message : String(err);
    const isExpectedNoDb =
      code === "SQLITE_CANTOPEN" ||
      code === "ENOENT" ||
      message.includes("SQLITE_CANTOPEN") ||
      message.includes("no such file") ||
      message.includes("directory does not exist") ||
      message.includes("Cannot open database");
    if (!isExpectedNoDb) throw err;
    // else: no existing workspace for this slug — proceed with creation
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
  const flow = await loadAndResolveFlow(pluginDir, input.flow_name);

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

  // Persist execution to SQLite.
  // Two concurrent callers can both pass the re-check above (both see no session)
  // and race to insert the singleton execution row. The loser gets a UNIQUE
  // constraint error. We catch that here and fall back to reading the row the
  // winner already inserted, returning a clean resume instead of propagating
  // the constraint error.
  try {
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
  } catch (err) {
    // Another concurrent caller already inserted the execution row.
    // Treat this as a resume: read what the winner wrote and return it.
    const isConstraintError =
      (err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      (err as { code?: string }).code === 'SQLITE_CONSTRAINT' ||
      (err instanceof Error && err.message.includes('UNIQUE constraint'));
    if (!isConstraintError) throw err;

    const winnerSession = store.getSession();
    if (winnerSession && winnerSession.status === 'active') {
      const winnerBoard = store.getBoard()!;
      return {
        workspace,
        slug: winnerSession.slug,
        board: winnerBoard,
        session: winnerSession,
        created: false,
        resume_state: winnerBoard.current_state,
      };
    }
    // Constraint error but still no session readable — re-throw.
    throw err;
  }

  // Persist initial state records
  for (const [stateId] of Object.entries(flow.states)) {
    store.upsertState(stateId, { status: "pending", entries: 0 });
    const stateDef = flow.states[stateId];
    // max_revisions (ADR-017) takes precedence over max_iterations, matching initBoard logic
    const maxIter = stateDef.max_revisions ?? stateDef.max_iterations;
    if (maxIter !== undefined) {
      store.upsertIteration(stateId, { count: 0, max: maxIter, history: [], cannot_fix: [] });
    } else if (stateDef.approval_gate === true && stateDef.type !== "terminal") {
      // Default revision budget for explicitly gated states without explicit limit
      store.upsertIteration(stateId, { count: 0, max: 3, history: [], cannot_fix: [] });
    }
  }

  // Compute shared prompt cache prefix (ADR-006a)
  // Content must be stable across all agent spawns in the workspace.
  // Progress is explicitly excluded — it is append-only and changes per state.
  const prefixParts: string[] = [];

  // 1. Flow description (from resolved flow metadata)
  if (flow.description) {
    prefixParts.push(`## Flow: ${flow.name}\n\n${flow.description}`);
  }

  // 2. Project conventions (CLAUDE.md from plugin dir if available)
  const claudeMdPath = join(pluginDir, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    try {
      const claudeMd = await readFile(claudeMdPath, "utf-8");
      prefixParts.push(claudeMd);
    } catch { /* graceful degradation — CLAUDE.md unreadable */ }
  }

  // 3. Workspace metadata (stable identifiers only)
  prefixParts.push(
    `## Workspace\n\n- Task: ${input.task}\n- Branch: ${input.branch}\n- Slug: ${slug}\n- Base commit: ${input.base_commit}`,
  );

  // 4. Project structure from KG (graceful degradation — skip if KG absent or fails)
  try {
    const kgDbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    if (existsSync(kgDbPath)) {
      const db = initDatabase(kgDbPath);
      try {
        const kgQuery = new KgQuery(db);

        // Get all files with layer info
        const allFiles = kgQuery.getAllFilesWithStats();
        const totalFiles = allFiles.length;

        // Layer breakdown: count files per layer
        const layerCounts = new Map<string, number>();
        const fileIdToPath = new Map<number, string>();
        for (const file of allFiles) {
          if (file.file_id !== undefined) {
            fileIdToPath.set(file.file_id, file.path);
          }
          const layer = file.layer || "unknown";
          layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
        }

        // Layer breakdown string: "api (12 files), domain (8 files), ..."
        const layerBreakdown = [...layerCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([layer, count]) => `${layer} (${count} file${count === 1 ? "" : "s"})`)
          .join(", ");

        // Top 5 hub files by in_degree
        const allDegrees = kgQuery.getAllFileDegrees();
        const hubEntries: Array<{ path: string; in_degree: number }> = [];
        for (const [fileId, degrees] of allDegrees) {
          const path = fileIdToPath.get(fileId);
          if (path !== undefined && degrees.in_degree > 0) {
            hubEntries.push({ path, in_degree: degrees.in_degree });
          }
        }
        hubEntries.sort((a, b) => b.in_degree - a.in_degree);
        const top5 = hubEntries.slice(0, 5);

        const hubLine = top5.length > 0
          ? `Hub files (high in-degree): ${top5.map((h) => `${h.path} (${h.in_degree})`).join(", ")}`
          : "Hub files (high in-degree): none";

        const projectStructure = [
          "## Project Structure",
          "",
          `Layers: ${layerBreakdown || "none"}`,
          hubLine,
          `Total files in graph: ${totalFiles}`,
        ].join("\n");

        prefixParts.push(projectStructure);
      } finally {
        db.close();
      }
    }
  } catch {
    // Graceful degradation — KG unavailable or query failed; skip project_structure
  }

  // 5. Project conventions from .canon/CONVENTIONS.md (graceful degradation — skip if absent)
  try {
    const conventionsPath = join(projectDir, CANON_DIR, "CONVENTIONS.md");
    if (existsSync(conventionsPath)) {
      const content = await readFile(conventionsPath, "utf-8");
      prefixParts.push(`## Conventions\n\n${content}`);
    }
  } catch {
    // Graceful degradation — CONVENTIONS.md unreadable; skip conventions
  }

  const cachePrefix = prefixParts.join("\n\n---\n\n");
  store.setCachePrefix(cachePrefix);

  const prefixHash = createHash("sha256").update(cachePrefix).digest("hex").slice(0, 12);

  // Seed progress
  store.appendProgress(`## Progress: ${input.task}`);

  // Create worktree for isolated builds (graceful fallback on failure)
  let actualWorktreePath: string | undefined;
  let actualWorktreeBranch: string | undefined;
  const worktreePath = join(projectDir, ".canon", "worktrees", slug);
  const worktreeBranch = `canon-build/${slug}`;
  const wtResult = gitWorktreeAdd(worktreePath, worktreeBranch, input.base_commit, projectDir);
  if (wtResult.ok) {
    actualWorktreePath = worktreePath;
    actualWorktreeBranch = worktreeBranch;
    session.worktree_path = worktreePath;
    session.worktree_branch = worktreeBranch;
  }

  return {
    workspace, slug, board, session, created: true,
    worktree_path: actualWorktreePath,
    worktree_branch: actualWorktreeBranch,
    cache_prefix_hash: prefixHash,
  };
}
