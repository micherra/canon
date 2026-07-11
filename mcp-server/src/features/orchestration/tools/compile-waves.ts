import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { TaskDag, TaskNode } from "@shared/lib/dag-validator.ts";
import { splitFrontmatter } from "@shared/lib/frontmatter.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { compileWaves, sanitizeTaskId, type WavesEnvelope } from "@shared/lib/waves-compiler.ts";
import { parse as parseYaml } from "yaml";

/**
 * compile_waves — thin MCP wrapper over the pure `compileWaves` compiler.
 *
 * Reads `${workspace}/plans/${slug}/task-dag.yaml` + each task's
 * `{task_id}-PLAN.md`, fills a self-contained worker prompt per task (the
 * `worker-prompt.md` variable set — see `buildPromptSeed` below), and calls
 * `compileWaves`. Read-only: no worktree creation or other side effects — the
 * orchestrator pre-creates worktrees from the returned `worktrees_to_create`
 * list before invoking the `workflows/canon-waves.js` runner.
 */

export type CompileWavesInput = {
  workspace: string;
  slug: string;
  base_commit: string;
  build_worktree: string;
  project_dir?: string;
};

export type WorktreeToCreate = {
  worktree_path: string;
  branch: string;
  base_commit: string;
};

export type CompileWavesToolResult = {
  envelope: WavesEnvelope;
  worktrees_to_create: WorktreeToCreate[];
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

type RawTaskDagTask = {
  task_id?: unknown;
  depends_on?: unknown;
  parallel_safe?: unknown;
  files?: unknown;
};

type RawTaskDag = {
  tasks?: RawTaskDagTask[];
};

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Normalize a parsed task-dag.yaml document into the validator's TaskDag shape. */
function normalizeTaskDag(raw: unknown): TaskDag {
  const rawDag = (raw ?? {}) as RawTaskDag;
  const tasks: TaskNode[] = (rawDag.tasks ?? []).map((task) => ({
    depends_on: toStringArray(task.depends_on),
    files: toStringArray(task.files),
    parallel_safe: typeof task.parallel_safe === "boolean" ? task.parallel_safe : true,
    task_id: typeof task.task_id === "string" ? task.task_id : "",
  }));
  return { tasks };
}

/** Strip `{project_dir}/.canon/workspaces/` prefix per worker-prompt.md's Template Notes. */
function deriveCanonParentWorkspace(workspace: string, projectDir: string): string {
  const prefix = `${projectDir}/.canon/workspaces/`;
  return workspace.startsWith(prefix) ? workspace.slice(prefix.length) : workspace;
}

type PromptSeedOpts = {
  taskId: string;
  worktreePath: string;
  branch: string;
  planBody: string;
  slug: string;
  workspace: string;
  projectDir: string;
  buildBaseCommit: string;
  canonParentWorkspace: string;
  modelTier: string;
};

/**
 * Build a self-contained prompt for a single canon-waves task worker.
 *
 * Reuses `templates/worker-prompt.md`'s variable set (WORKER_NAME, PROJECT_DIR,
 * WORKSPACE, SLUG, CANON_PARENT_WORKSPACE, BUILD_BASE_COMMIT, MODEL_TIER) but
 * embeds the task plan directly rather than relying on a TaskList pull-loop —
 * canon-waves direct-assigns one worker per task via `parallel()`, so there is
 * no task queue to pull a description from.
 */
function buildPromptSeed(opts: PromptSeedOpts): string {
  return [
    `You are a Canon build worker (${opts.taskId}) for build ${opts.slug}.`,
    "",
    "## Step 0 (REQUIRED) — L4 hook authorization",
    "```bash",
    `export CANON_PARENT_WORKSPACE="${opts.canonParentWorkspace}"`,
    "```",
    'If CANON_PARENT_WORKSPACE is empty or unset, STOP and return {"status":"blocked","note":"L4 hook authorization failed"}.',
    "",
    "## Step 1 — worktree safety guard",
    `Using Bash, run: git -C ${opts.worktreePath} rev-parse --show-toplevel`,
    `Confirm the output resolves to exactly "${opts.worktreePath}" (your Canon-owned task worktree). If it does not match, STOP and return {"status":"blocked","note":"worktree mismatch: expected ${opts.worktreePath}"} without making any changes.`,
    "",
    "## Step 2 — do the work",
    `Work ONLY in ${opts.worktreePath} (never the project root or build worktree). Follow the task plan below exactly.`,
    "",
    "## Step 3 — commit",
    `Commit with Canon provenance trailers: Canon-Workflow: ${opts.slug}, Canon-Agent: engineer, Canon-State: implement, Canon-Task: ${opts.taskId}.`,
    "",
    "## Step 4 — return",
    'Return {"status":"ok","note":"<the resulting commit sha>"} on success, {"status":"blocked","note":"<the exact error output>"} otherwise.',
    "",
    `PROJECT_DIR=${opts.projectDir}`,
    `WORKSPACE=${opts.workspace}`,
    `BUILD_BASE_COMMIT=${opts.buildBaseCommit}`,
    `MODEL_TIER=${opts.modelTier}`,
    `BRANCH=${opts.branch}`,
    "",
    "## Task Plan",
    "",
    opts.planBody,
  ].join("\n");
}

export async function compileWavesTool(
  input: CompileWavesInput,
  defaultProjectDir: string,
): Promise<ToolResult<CompileWavesToolResult>> {
  if (!isAbsolute(input.workspace)) {
    return toolError(
      "INVALID_INPUT",
      `workspace must be an absolute path; got: "${input.workspace}"`,
    );
  }
  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError("INVALID_INPUT", `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`);
  }

  const projectDir = input.project_dir ?? defaultProjectDir;
  const plansDir = join(input.workspace, "plans", input.slug);
  const dagPath = join(plansDir, "task-dag.yaml");

  let dagContent: string;
  try {
    dagContent = await readFile(dagPath, "utf-8");
  } catch {
    return toolError("WORKSPACE_NOT_FOUND", `task-dag.yaml not found at ${dagPath}`);
  }

  let rawDag: unknown;
  try {
    rawDag = parseYaml(dagContent);
  } catch (err) {
    return toolError(
      "INVALID_INPUT",
      `task-dag.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const dag = normalizeTaskDag(rawDag);
  const canonParentWorkspace = deriveCanonParentWorkspace(input.workspace, projectDir);

  const promptSeeds: Record<string, string> = {};
  for (const task of dag.tasks) {
    const planPath = join(plansDir, `${task.task_id}-PLAN.md`);
    let planRaw: string;
    try {
      planRaw = await readFile(planPath, "utf-8");
    } catch {
      return toolError("WORKSPACE_NOT_FOUND", `Task plan not found: ${planPath}`);
    }
    const { body } = splitFrontmatter(planRaw);
    const sanitized = sanitizeTaskId(task.task_id);

    promptSeeds[task.task_id] = buildPromptSeed({
      branch: `canon-task/${sanitized}`,
      buildBaseCommit: input.base_commit,
      canonParentWorkspace,
      modelTier: "sonnet",
      planBody: body.trim(),
      projectDir,
      slug: input.slug,
      taskId: task.task_id,
      workspace: input.workspace,
      worktreePath: `${projectDir}/.canon/worktrees/${sanitized}`,
    });
  }

  const compileResult = compileWaves({
    base_commit: input.base_commit,
    build_worktree: input.build_worktree,
    dag,
    project_dir: projectDir,
    prompt_seeds: promptSeeds,
    slug: input.slug,
  });

  if (!compileResult.ok) {
    return toolError("INVALID_INPUT", compileResult.errors.join("; "));
  }

  const worktreesToCreate: WorktreeToCreate[] = compileResult.envelope.waves[0].tasks.map(
    (task) => ({
      base_commit: input.base_commit,
      branch: task.branch,
      worktree_path: task.worktree_path,
    }),
  );

  return toolOk({ envelope: compileResult.envelope, worktrees_to_create: worktreesToCreate });
}
