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

async function seedPlans(plansDir: string, dagYaml: string, taskIds: string[]): Promise<void> {
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
    expect(result.envelope.merge_order).toEqual(["canon-task/task-a", "canon-task/task-b"]);

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
    // The envelope's branch and the prompt seed's embedded BRANCH= line must
    // NEVER drift apart — both derive from the single `deriveTaskBranch`
    // owner in waves-compiler.ts, not two independent templates.
    expect(taskA?.prompt_seed).toContain(`BRANCH=${taskA?.branch}`);
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
    expect(result.worktrees_to_create[0].worktree_path).toContain(
      "/fallback-proj/.canon/worktrees/",
    );
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

describe("compileWavesTool — task_id charset guard (security F1)", () => {
  it("rejects a task_id containing path-traversal characters BEFORE reading any plan file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "compile-waves-test-"));
    const plansDir = join(tmpDir, "plans", "my-slug");
    // Deliberately do NOT seed a `{task_id}-PLAN.md` for the malicious task_id —
    // if the guard didn't fire before the plan read, this would surface as
    // WORKSPACE_NOT_FOUND instead of INVALID_INPUT, proving the read never happened.
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, "task-dag.yaml"),
      `
tasks:
  - task_id: "../../etc/evil"
    depends_on: []
    parallel_safe: true
    files:
      - "src/a.ts"
`,
      "utf-8",
    );

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
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.message).toContain("task_id");
  });

  it("rejects a slash-free '..' task_id (defense-in-depth gap: charset-identity alone admits it)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "compile-waves-test-"));
    const plansDir = join(tmpDir, "plans", "my-slug");
    // No slash at all — `sanitizeTaskId("..") === ".."`, so the old
    // identity-sanitize test passed this straight through. Deliberately do
    // NOT seed a `..-PLAN.md` — if the guard didn't fire before the plan
    // read, this would surface as WORKSPACE_NOT_FOUND instead of
    // INVALID_INPUT, proving the read never happened.
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, "task-dag.yaml"),
      `
tasks:
  - task_id: ".."
    depends_on: []
    parallel_safe: true
    files:
      - "src/a.ts"
`,
      "utf-8",
    );

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
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.message).toContain("task_id");
  });

  it("rejects a task_id containing spaces", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "compile-waves-test-"));
    const plansDir = join(tmpDir, "plans", "my-slug");
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      join(plansDir, "task-dag.yaml"),
      `
tasks:
  - task_id: "task with spaces"
    depends_on: []
    parallel_safe: true
    files:
      - "src/a.ts"
`,
      "utf-8",
    );

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
    expect(result.error_code).toBe("INVALID_INPUT");
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
