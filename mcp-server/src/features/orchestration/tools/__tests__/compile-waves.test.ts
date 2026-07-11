import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileWavesTool } from "../compile-waves.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { force: true, recursive: true });
});

const TASK_DAG_TWO_TASKS = `
tasks:
  - task_id: "task-a"
    depends_on: []
    parallel_safe: true
    files:
      - "src/a.ts"
  - task_id: "task-b"
    depends_on: []
    parallel_safe: true
    files:
      - "src/b.ts"
`;

const TASK_DAG_MULTI_WAVE = `
tasks:
  - task_id: "root"
    depends_on: []
    parallel_safe: true
    files:
      - "src/root.ts"
  - task_id: "child"
    depends_on:
      - "root"
    parallel_safe: true
    files:
      - "src/child.ts"
`;

async function seedPlans(
  plansDir: string,
  dagYaml: string,
  taskIds: string[],
): Promise<void> {
  await mkdir(plansDir, { recursive: true });
  await writeFile(join(plansDir, "task-dag.yaml"), dagYaml, "utf-8");
  for (const taskId of taskIds) {
    await writeFile(
      join(plansDir, `${taskId}-PLAN.md`),
      `---\ntask_id: "${taskId}"\n---\n\n## Task: ${taskId}\n\nDo the thing.\n`,
      "utf-8",
    );
  }
}

describe("compileWavesTool — happy path", () => {
  it("returns an envelope + worktrees_to_create for a two-task single-wave DAG", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "compile-waves-test-"));
    const plansDir = join(tmpDir, "plans", "my-slug");
    await seedPlans(plansDir, TASK_DAG_TWO_TASKS, ["task-a", "task-b"]);

    const result = await compileWavesTool(
      {
        base_commit: "abc123",
        build_worktree: `${tmpDir}/worktree`,
        project_dir: "/proj",
        slug: "my-slug",
        workspace: tmpDir,
      },
      "/proj",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.envelope.envelope_version).toBe(1);
    expect(result.envelope.slug).toBe("my-slug");
    expect(result.envelope.waves).toHaveLength(1);
    expect(result.envelope.waves[0].tasks).toHaveLength(2);
    expect(result.envelope.merge_order).toEqual(["task-a", "task-b"]);

    expect(result.worktrees_to_create).toHaveLength(2);
    for (const wt of result.worktrees_to_create) {
      expect(wt.base_commit).toBe("abc123");
      expect(wt.worktree_path).toContain("/proj/.canon/worktrees/");
      expect(wt.branch).toContain("canon-task/");
    }

    // Prompt seeds embed the plan body and the task's worktree path (safety guard).
    const taskA = result.envelope.waves[0].tasks.find((t) => t.task_id === "task-a");
    expect(taskA?.prompt_seed).toContain("Do the thing.");
    expect(taskA?.prompt_seed).toContain(taskA?.worktree_path);
  });

  it("defaults project_dir to the caller-supplied fallback when omitted", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "compile-waves-test-"));
    const plansDir = join(tmpDir, "plans", "my-slug");
    await seedPlans(plansDir, TASK_DAG_TWO_TASKS, ["task-a", "task-b"]);

    const result = await compileWavesTool(
      {
        base_commit: "abc123",
        build_worktree: `${tmpDir}/worktree`,
        slug: "my-slug",
        workspace: tmpDir,
      },
      "/fallback-proj",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.worktrees_to_create[0].worktree_path).toContain("/fallback-proj/.canon/worktrees/");
  });
});

describe("compileWavesTool — fail-closed on compileWaves validation error", () => {
  it("returns INVALID_INPUT (no envelope) for a multi-wave DAG", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "compile-waves-test-"));
    const plansDir = join(tmpDir, "plans", "my-slug");
    await seedPlans(plansDir, TASK_DAG_MULTI_WAVE, ["root", "child"]);

    const result = await compileWavesTool(
      {
        base_commit: "abc123",
        build_worktree: `${tmpDir}/worktree`,
        project_dir: "/proj",
        slug: "my-slug",
        workspace: tmpDir,
      },
      "/proj",
    );

    expect(result.ok).toBe(false);
    expect("envelope" in result).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.message).toContain("multi-wave");
  });
});

describe("compileWavesTool — WORKSPACE_NOT_FOUND", () => {
  it("returns WORKSPACE_NOT_FOUND when task-dag.yaml is absent", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "compile-waves-test-"));

    const result = await compileWavesTool(
      {
        base_commit: "abc123",
        build_worktree: `${tmpDir}/worktree`,
        project_dir: "/proj",
        slug: "my-slug",
        workspace: tmpDir,
      },
      "/proj",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("compileWavesTool — read-only", () => {
  it("does not create the worktrees_to_create paths on disk (side-effect-free)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "compile-waves-test-"));
    const plansDir = join(tmpDir, "plans", "my-slug");
    await seedPlans(plansDir, TASK_DAG_TWO_TASKS, ["task-a", "task-b"]);

    const result = await compileWavesTool(
      {
        base_commit: "abc123",
        build_worktree: `${tmpDir}/worktree`,
        project_dir: "/proj",
        slug: "my-slug",
        workspace: tmpDir,
      },
      "/proj",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // /proj/.canon/worktrees/... is a fictional path in this test — it must
    // not have been created by the tool (read-only contract).
    const { access } = await import("node:fs/promises");
    await expect(access("/proj/.canon/worktrees/task-a")).rejects.toThrow();
  });
});
