import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { writePlanIndex } from "../tools/write-plan-index.ts";
import { seedExecution } from "./seed-execution-test-helper.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

// Valid input — happy path

describe("writePlanIndex — valid input", () => {
  it("creates INDEX.md and returns path, task_count, wave_count", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    seedExecution(tmpDir);
    const result = await writePlanIndex({
      slug: "my-epic",
      tasks: [
        { task_id: "task-01", wave: 1 },
        { task_id: "task-02", wave: 1 },
        { task_id: "task-03", wave: 2 },
      ],
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.task_count).toBe(3);
    expect(result.wave_count).toBe(2);
    expect(result.path).toContain("INDEX.md");
    expect(result.path).toContain("my-epic");
  });

  it("writes a parseable markdown table", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    seedExecution(tmpDir);
    const result = await writePlanIndex({
      slug: "my-epic",
      tasks: [
        {
          depends_on: ["task-00"],
          files: ["src/foo.ts"],
          principles: ["thin-handlers"],
          task_id: "task-01",
          wave: 1,
        },
        { task_id: "task-02", wave: 2 },
      ],
      workspace: tmpDir,
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("task-01");
    expect(content).toContain("task-02");
    expect(content).toContain("| Task |");
    expect(content).toContain("| task-01 | 1 |");
    expect(content).toContain("| task-02 | 2 |");
  });

  it("creates the plans directory if it does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    seedExecution(tmpDir);
    const result = await writePlanIndex({
      slug: "new-slug",
      tasks: [{ task_id: "t-01", wave: 1 }],
      workspace: tmpDir,
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("t-01");
  });

  it("handles optional fields (depends_on, files, principles)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    seedExecution(tmpDir);
    const result = await writePlanIndex({
      slug: "test-slug",
      tasks: [
        {
          depends_on: ["prereq-01"],
          files: ["src/a.ts", "src/b.ts"],
          principles: ["errors-are-values"],
          task_id: "t-01",
          wave: 1,
        },
      ],
      workspace: tmpDir,
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("prereq-01");
    expect(content).toContain("src/a.ts");
    expect(content).toContain("errors-are-values");
  });

  it("wave_count is 1 when all tasks are in the same wave", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    seedExecution(tmpDir);
    const result = await writePlanIndex({
      slug: "single-wave",
      tasks: [
        { task_id: "t-01", wave: 3 },
        { task_id: "t-02", wave: 3 },
      ],
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.wave_count).toBe(1);
  });
});

describe("writePlanIndex — relative workspace rejection", () => {
  it("returns INVALID_INPUT when workspace is a relative path", async () => {
    const result = await writePlanIndex({
      slug: "my-epic",
      tasks: [{ task_id: "task-01", wave: 1 }],
      workspace: "relative/path",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("absolute");
    }
  });
});

describe("writePlanIndex — validation errors", () => {
  it("returns INVALID_INPUT for task_id with spaces", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    seedExecution(tmpDir);
    const result = await writePlanIndex({
      slug: "my-epic",
      tasks: [{ task_id: "task with spaces", wave: 1 }],
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("task with spaces");
    }
  });

  it("returns INVALID_INPUT for task_id with special chars", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    seedExecution(tmpDir);
    const result = await writePlanIndex({
      slug: "my-epic",
      tasks: [{ task_id: "task@01!", wave: 1 }],
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for duplicate task IDs", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    seedExecution(tmpDir);
    const result = await writePlanIndex({
      slug: "my-epic",
      tasks: [
        { task_id: "task-01", wave: 1 },
        { task_id: "task-01", wave: 2 },
      ],
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("task-01");
    }
  });

  it("returns INVALID_INPUT for wave < 1", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    seedExecution(tmpDir);
    const result = await writePlanIndex({
      slug: "my-epic",
      tasks: [{ task_id: "task-01", wave: 0 }],
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("wave");
    }
  });

  it("returns INVALID_INPUT for negative wave", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    seedExecution(tmpDir);
    const result = await writePlanIndex({
      slug: "my-epic",
      tasks: [{ task_id: "task-01", wave: -1 }],
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});

describe("writePlanIndex — fail-closed on unbacked workspace", () => {
  it("returns WORKSPACE_NOT_FOUND and writes no artifact when the workspace has no execution row", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    // Deliberately NOT seeded — workspace has no execution row.

    const result = await writePlanIndex({
      slug: "unbacked-slug",
      tasks: [{ task_id: "task-01", wave: 1 }],
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
      expect(result.message).toContain(tmpDir);
    }
    expect(existsSync(join(tmpDir, "plans", "unbacked-slug", "INDEX.md"))).toBe(false);
  });
});
