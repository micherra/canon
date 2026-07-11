/**
 * waves-compiler.ts — the generic canon-waves compiler (SYNTHESIS Inc-5, Increment 1).
 *
 * Pure leaf module: reads a validated `TaskDag` + per-task prompt seeds and
 * derives a `WavesEnvelope` data envelope — no per-flow branches, behavior
 * comes only from DAG/plan fields (the genericity constraint, see AC1's
 * field-only-diff test in `__tests__/waves-compiler.test.ts`).
 *
 * Increment 1 is single-wave only: any task with a non-empty `depends_on`
 * is rejected (fail-closed) rather than guessed at — multi-wave dependency
 * ordering (wave N branching from wave N-1's merged HEAD) is not
 * probe-validated and is deferred to a later increment (DESIGN.md
 * Assumption 4 / ADR-0053).
 */

import { type TaskDag, type TaskNode, validateDag } from "./dag-validator.ts";

export type WavesTask = {
  task_id: string;
  branch: string;
  worktree_path: string;
  files: string[];
  prompt_seed: string;
};

export type Wave = {
  wave: number;
  tasks: WavesTask[];
};

export type WavesEnvelope = {
  envelope_version: 1;
  slug: string;
  base_commit: string;
  waves: Wave[];
  build_worktree: string;
  merge_order: string[];
};

export type CompileWavesInput = {
  dag: TaskDag;
  slug: string;
  base_commit: string;
  build_worktree: string;
  project_dir: string;
  /** Filled worker-prompt.md content per task_id — the caller reads files, not this module. */
  prompt_seeds: Record<string, string>;
};

export type CompileWavesResult = { ok: true; envelope: WavesEnvelope } | { ok: false; errors: string[] };

const SANITIZE_PATTERN = /[^A-Za-z0-9._-]/g;

/** Sanitize a task_id for use in a branch name / worktree path (non-charset chars -> `-`). */
function sanitizeTaskId(taskId: string): string {
  return taskId.replace(SANITIZE_PATTERN, "-");
}

/** Increment-1 single-wave assertion: any task with dependencies is out of scope. */
function collectMultiWaveErrors(dag: TaskDag): string[] {
  const errors: string[] = [];
  for (const task of dag.tasks) {
    if (task.depends_on.length > 0) {
      errors.push(
        `multi-wave DAGs are out of scope for canon-waves increment 1 (task '${task.task_id}' has dependencies); use the manual dag-execution-protocol fallback`,
      );
    }
  }
  return errors;
}

/** Arity/shape check (probe finding #3): every task must have a non-empty prompt_seed. */
function collectArityErrors(dag: TaskDag, promptSeeds: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const task of dag.tasks) {
    const seed = promptSeeds[task.task_id];
    if (!seed || seed.trim() === "") {
      errors.push(`missing prompt_seed for task '${task.task_id}'`);
    }
  }
  return errors;
}

/** Derive a WavesTask from a validated TaskNode + the caller-supplied prompt seed. */
function buildWavesTask(task: TaskNode, input: CompileWavesInput): WavesTask {
  const sanitized = sanitizeTaskId(task.task_id);
  return {
    branch: `canon-task/${sanitized}`,
    files: task.files,
    prompt_seed: input.prompt_seeds[task.task_id],
    task_id: task.task_id,
    worktree_path: `${input.project_dir}/.canon/worktrees/${sanitized}`,
  };
}

/**
 * Compile a validated task-dag + per-task prompt seeds into a WavesEnvelope.
 *
 * Fail-closed at every stage: DAG validation failure, multi-wave (increment-1
 * scope boundary), or arity failure each return `{ ok: false, errors }` —
 * never a partial or guessed envelope.
 */
export function compileWaves(input: CompileWavesInput): CompileWavesResult {
  const validation = validateDag(input.dag);
  if (!validation.valid) {
    return { errors: validation.errors, ok: false };
  }

  const multiWaveErrors = collectMultiWaveErrors(input.dag);
  if (multiWaveErrors.length > 0) {
    return { errors: multiWaveErrors, ok: false };
  }

  const arityErrors = collectArityErrors(input.dag, input.prompt_seeds);
  if (arityErrors.length > 0) {
    return { errors: arityErrors, ok: false };
  }

  const tasks = input.dag.tasks.map((task) => buildWavesTask(task, input));
  const mergeOrder = input.dag.tasks.map((task) => task.task_id).sort();

  return {
    envelope: {
      base_commit: input.base_commit,
      build_worktree: input.build_worktree,
      envelope_version: 1,
      merge_order: mergeOrder,
      slug: input.slug,
      waves: [{ tasks, wave: 1 }],
    },
    ok: true,
  };
}
