import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { writeImplementationSummary } from "../tools/write-implementation-summary.ts";
import { seedExecution } from "./seed-execution-test-helper.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

// Valid input — happy path

describe("writeImplementationSummary — valid input", () => {
  it("writes {task_id}-SUMMARY.md and .meta.json to correct location", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [
        {
          action: "added",
          path: "src/features/orchestration/tools/write-implementation-summary.ts",
        },
        { action: "added", path: "src/__tests__/write-implementation-summary.test.ts" },
      ],
      slug: "my-epic",
      task_id: "adr010-03",
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.path).toContain("adr010-03-SUMMARY.md");
    expect(result.path).toContain("my-epic");
    expect(result.meta_path).toContain("adr010-03-SUMMARY.meta.json");
    expect(result.meta_path).toContain("my-epic");
    expect(result.files_changed_count).toBe(2);

    // Verify both files exist by reading them
    const md = await readFile(result.path, "utf-8");
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(md).toBeTruthy();
    expect(meta).toBeTruthy();
  });

  it("markdown contains files changed table with correct actions", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [
        { action: "added", path: "src/foo.ts" },
        { action: "modified", path: "src/bar.ts" },
        { action: "deleted", path: "src/old.ts" },
      ],
      slug: "test-epic",
      task_id: "task-01",
      workspace: tmpDir,
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("Implementation Summary");
    expect(content).toContain("task-01");
    expect(content).toContain("src/foo.ts");
    expect(content).toContain("added");
    expect(content).toContain("src/bar.ts");
    expect(content).toContain("modified");
    expect(content).toContain("src/old.ts");
    expect(content).toContain("deleted");
  });

  it("meta JSON has _type: implementation_summary and _version: 1", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [{ action: "added", path: "src/tools/foo.ts" }],
      slug: "my-epic",
      task_id: "adr010-03",
      workspace: tmpDir,
    });

    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta._type).toBe("implementation_summary");
    expect(meta._version).toBe(1);
    expect(meta.task_id).toBe("adr010-03");
    expect(meta.files_changed).toHaveLength(1);
    expect(meta.files_changed[0].path).toBe("src/tools/foo.ts");
    expect(meta.files_changed[0].action).toBe("added");
  });

  it("handles optional fields omitted (no decisions_applied, deviations, tests_added)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [],
      slug: "my-epic",
      task_id: "task-01",
      workspace: tmpDir,
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));

    // Should not crash, markdown and meta should be written
    expect(content).toContain("task-01");
    expect(meta.decisions_applied).toBeUndefined();
    expect(meta.deviations).toBeUndefined();
    expect(meta.tests_added).toBeUndefined();
    expect(result.files_changed_count).toBe(0);
  });

  it("includes decisions_applied in markdown and meta when provided", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      decisions_applied: ["dec-01", "dec-03"],
      files_changed: [],
      slug: "my-epic",
      task_id: "task-01",
      workspace: tmpDir,
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));

    expect(content).toContain("dec-01");
    expect(content).toContain("dec-03");
    expect(meta.decisions_applied).toEqual(["dec-01", "dec-03"]);
  });

  it("includes deviations in markdown and meta when provided", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      deviations: [
        { decision_id: "dec-02", reason: "legacy constraint prevented strict compliance" },
      ],
      files_changed: [],
      slug: "my-epic",
      task_id: "task-01",
      workspace: tmpDir,
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));

    expect(content).toContain("dec-02");
    expect(content).toContain("legacy constraint prevented strict compliance");
    expect(meta.deviations).toHaveLength(1);
    expect(meta.deviations[0].decision_id).toBe("dec-02");
    expect(meta.deviations[0].reason).toBe("legacy constraint prevented strict compliance");
  });

  it("includes tests_added in markdown and meta when provided", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [],
      slug: "my-epic",
      task_id: "task-01",
      tests_added: [
        "src/__tests__/write-implementation-summary.test.ts",
        "src/__tests__/other.test.ts",
      ],
      workspace: tmpDir,
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));

    expect(content).toContain("write-implementation-summary.test.ts");
    expect(content).toContain("other.test.ts");
    expect(meta.tests_added).toEqual([
      "src/__tests__/write-implementation-summary.test.ts",
      "src/__tests__/other.test.ts",
    ]);
  });

  it("all optional fields included in markdown and meta", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      decisions_applied: ["dec-01"],
      deviations: [{ decision_id: "dec-02", reason: "test reason" }],
      files_changed: [
        { action: "added", path: "src/a.ts" },
        { action: "modified", path: "src/b.ts" },
      ],
      slug: "full-epic",
      task_id: "full-task-01",
      tests_added: ["src/__tests__/a.test.ts"],
      workspace: tmpDir,
    });

    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta._type).toBe("implementation_summary");
    expect(meta._version).toBe(1);
    expect(meta.task_id).toBe("full-task-01");
    expect(meta.files_changed).toHaveLength(2);
    expect(meta.decisions_applied).toEqual(["dec-01"]);
    expect(meta.deviations).toHaveLength(1);
    expect(meta.tests_added).toEqual(["src/__tests__/a.test.ts"]);
    expect(result.files_changed_count).toBe(2);
  });

  it("creates the plans directory if it does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [],
      slug: "new-slug",
      task_id: "t-01",
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.path).toContain("new-slug");
  });

  it("different task_ids produce different output filenames (DAG collision prevention)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const resultA = await writeImplementationSummary({
      files_changed: [{ action: "added", path: "src/a.ts" }],
      slug: "my-epic",
      task_id: "task-alpha",
      workspace: tmpDir,
    });

    const resultB = await writeImplementationSummary({
      files_changed: [{ action: "added", path: "src/b.ts" }],
      slug: "my-epic",
      task_id: "task-beta",
      workspace: tmpDir,
    });

    assertOk(resultA);
    assertOk(resultB);

    // Paths must differ — different task_ids must not collide
    expect(resultA.path).not.toBe(resultB.path);
    expect(resultA.meta_path).not.toBe(resultB.meta_path);

    // Each path must contain its own task_id
    expect(resultA.path).toContain("task-alpha");
    expect(resultB.path).toContain("task-beta");
  });
});

describe("writeImplementationSummary — write receipt", () => {
  it("emits a write_receipt event of kind 'implementation_summary' pointing at the SUMMARY path", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [{ action: "added", path: "src/a.ts" }],
      slug: "my-epic",
      task_id: "task-01",
      workspace: tmpDir,
    });

    assertOk(result);
    const store = getExecutionStore(tmpDir);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("implementation_summary");
    expect(events[0].payload.artifact_path).toBe(result.path);
    expect(events[0].payload.task_id).toBe("task-01");
  });
});

describe("writeImplementationSummary — relative workspace rejection", () => {
  it("returns INVALID_INPUT when workspace is a relative path", async () => {
    const result = await writeImplementationSummary({
      files_changed: [],
      slug: "my-epic",
      task_id: "task-01",
      workspace: "relative/path",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("absolute");
    }
  });
});

describe("writeImplementationSummary — validation errors", () => {
  it("returns INVALID_INPUT for invalid slug (spaces)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [],
      slug: "invalid slug",
      task_id: "task-01",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("invalid slug");
    }
  });

  it("returns INVALID_INPUT for invalid slug (special chars)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [],
      slug: "my/epic!",
      task_id: "task-01",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for invalid task_id (spaces)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [],
      slug: "my-epic",
      task_id: "task 01",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("task 01");
    }
  });

  it("returns INVALID_INPUT for invalid task_id (special chars)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [],
      slug: "my-epic",
      task_id: "task@01!",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for path traversal in slug", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    seedExecution(tmpDir);
    const result = await writeImplementationSummary({
      files_changed: [],
      slug: "../evil",
      task_id: "task-01",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});

describe("writeImplementationSummary — fail-closed on unbacked workspace", () => {
  it("returns WORKSPACE_NOT_FOUND and writes no artifact when the workspace has no execution row", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));
    // Deliberately NOT seeded — workspace has no execution row.

    const result = await writeImplementationSummary({
      files_changed: [{ action: "modified", path: "src/foo.ts" }],
      slug: "unbacked-slug",
      task_id: "task-01",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
      expect(result.message).toContain(tmpDir);
    }
    expect(existsSync(join(tmpDir, "plans", "unbacked-slug", "task-01-SUMMARY.md"))).toBe(false);
  });
});
