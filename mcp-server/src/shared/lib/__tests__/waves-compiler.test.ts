/**
 * waves-compiler.test.ts — Tests for compileWaves
 *
 * Tests cover:
 * 1. AC1 field-only-diff: two structurally-different single-wave DAGs compile
 *    to envelopes that differ ONLY in field values, not shape/code path.
 * 2. Single-wave assertion: any task with depends_on -> ok:false, scope message.
 * 3. Invalid DAG (cycle) -> ok:false surfacing validateDag errors.
 * 4. Missing prompt_seed -> ok:false (arity check).
 * 5. Sanitization: task_id with slashes/spaces -> sanitized branch + worktree path.
 */

import { describe, expect, it } from "vitest";
import type { TaskDag } from "../dag-validator.ts";
import { compileWaves } from "../waves-compiler.ts";

const BASE_INPUT = {
  base_commit: "abc123",
  build_worktree: "/proj/.canon/workspaces/main/slug/worktree",
  project_dir: "/proj",
  slug: "slug",
};

describe("compileWaves — AC1 field-only-diff (genericity proof)", () => {
  it("compiles two structurally-different single-wave DAGs into same-shaped envelopes differing only in values", () => {
    const dagA: TaskDag = {
      tasks: [{ depends_on: [], files: ["a.ts"], parallel_safe: true, task_id: "task-a" }],
    };
    const dagB: TaskDag = {
      tasks: [
        { depends_on: [], files: ["b1.ts"], parallel_safe: true, task_id: "task-b1" },
        { depends_on: [], files: ["b2.ts", "b3.ts"], parallel_safe: true, task_id: "task-b2" },
      ],
    };

    const resultA = compileWaves({
      ...BASE_INPUT,
      dag: dagA,
      prompt_seeds: { "task-a": "seed-a" },
    });
    const resultB = compileWaves({
      ...BASE_INPUT,
      dag: dagB,
      prompt_seeds: { "task-b1": "seed-b1", "task-b2": "seed-b2" },
    });

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    // Same shape: exactly one wave in both, same top-level envelope keys.
    expect(resultA.envelope.waves.length).toBe(1);
    expect(resultB.envelope.waves.length).toBe(1);
    expect(Object.keys(resultA.envelope).sort()).toEqual(Object.keys(resultB.envelope).sort());

    // Same per-task shape (keys), differing only in values.
    const taskKeysA = Object.keys(resultA.envelope.waves[0].tasks[0]).sort();
    const taskKeysB = Object.keys(resultB.envelope.waves[0].tasks[0]).sort();
    expect(taskKeysA).toEqual(taskKeysB);

    // Field values genuinely differ (proving no shared hardcoded output).
    expect(resultA.envelope.waves[0].tasks.length).toBe(1);
    expect(resultB.envelope.waves[0].tasks.length).toBe(2);
    expect(resultA.envelope.merge_order).toEqual(["task-a"]);
    expect(resultB.envelope.merge_order).toEqual(["task-b1", "task-b2"]);
  });
});

describe("compileWaves — single-wave assertion", () => {
  it("rejects a DAG with any depends_on (multi-wave, out of increment-1 scope)", () => {
    const dag: TaskDag = {
      tasks: [
        { depends_on: [], files: ["a.ts"], parallel_safe: true, task_id: "root" },
        { depends_on: ["root"], files: ["b.ts"], parallel_safe: true, task_id: "child" },
      ],
    };
    const result = compileWaves({
      ...BASE_INPUT,
      dag,
      prompt_seeds: { child: "seed-child", root: "seed-root" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("multi-wave"))).toBe(true);
    expect(result.errors.some((e) => e.includes("child"))).toBe(true);
  });
});

describe("compileWaves — invalid DAG", () => {
  it("surfaces validateDag errors for a cycle without guessing an envelope", () => {
    const dag: TaskDag = {
      tasks: [
        { depends_on: ["b"], files: [], parallel_safe: true, task_id: "a" },
        { depends_on: ["a"], files: [], parallel_safe: true, task_id: "b" },
      ],
    };
    const result = compileWaves({ ...BASE_INPUT, dag, prompt_seeds: { a: "sa", b: "sb" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("Cycle detected"))).toBe(true);
  });
});

describe("compileWaves — arity check", () => {
  it("rejects when a task is missing a prompt_seed entry", () => {
    const dag: TaskDag = {
      tasks: [{ depends_on: [], files: ["a.ts"], parallel_safe: true, task_id: "task-a" }],
    };
    const result = compileWaves({ ...BASE_INPUT, dag, prompt_seeds: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("prompt_seed"))).toBe(true);
    expect(result.errors.some((e) => e.includes("task-a"))).toBe(true);
  });

  it("rejects when a task's prompt_seed is empty/whitespace-only", () => {
    const dag: TaskDag = {
      tasks: [{ depends_on: [], files: ["a.ts"], parallel_safe: true, task_id: "task-a" }],
    };
    const result = compileWaves({ ...BASE_INPUT, dag, prompt_seeds: { "task-a": "   " } });
    expect(result.ok).toBe(false);
  });
});

describe("compileWaves — sanitization", () => {
  it("sanitizes a task_id with slashes/spaces into branch + worktree path", () => {
    const dag: TaskDag = {
      tasks: [
        { depends_on: [], files: ["a.ts"], parallel_safe: true, task_id: "feat/my task#1" },
      ],
    };
    const result = compileWaves({
      ...BASE_INPUT,
      dag,
      prompt_seeds: { "feat/my task#1": "seed" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = result.envelope.waves[0].tasks[0];
    expect(task.task_id).toBe("feat/my task#1");
    expect(task.branch).toBe("canon-task/feat-my-task-1");
    expect(task.worktree_path).toBe("/proj/.canon/worktrees/feat-my-task-1");
  });
});
