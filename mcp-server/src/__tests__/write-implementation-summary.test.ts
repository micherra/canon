import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeImplementationSummary } from "../tools/write-implementation-summary.ts";
import { assertOk } from "../utils/tool-result.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Valid input — happy path
// ---------------------------------------------------------------------------

describe("writeImplementationSummary — valid input", () => {
  it("writes IMPLEMENTATION-SUMMARY.md and .meta.json to correct location", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "adr010-03",
      files_changed: [
        { path: "src/tools/write-implementation-summary.ts", action: "added" },
        { path: "src/__tests__/write-implementation-summary.test.ts", action: "added" },
      ],
    });

    assertOk(result);
    expect(result.path).toContain("IMPLEMENTATION-SUMMARY.md");
    expect(result.path).toContain("my-epic");
    expect(result.meta_path).toContain("IMPLEMENTATION-SUMMARY.meta.json");
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

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "test-epic",
      task_id: "task-01",
      files_changed: [
        { path: "src/foo.ts", action: "added" },
        { path: "src/bar.ts", action: "modified" },
        { path: "src/old.ts", action: "deleted" },
      ],
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

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "adr010-03",
      files_changed: [
        { path: "src/tools/foo.ts", action: "added" },
      ],
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

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task-01",
      files_changed: [],
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

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task-01",
      files_changed: [],
      decisions_applied: ["dec-01", "dec-03"],
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

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task-01",
      files_changed: [],
      deviations: [
        { decision_id: "dec-02", reason: "legacy constraint prevented strict compliance" },
      ],
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

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task-01",
      files_changed: [],
      tests_added: [
        "src/__tests__/write-implementation-summary.test.ts",
        "src/__tests__/other.test.ts",
      ],
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

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "full-epic",
      task_id: "full-task-01",
      files_changed: [
        { path: "src/a.ts", action: "added" },
        { path: "src/b.ts", action: "modified" },
      ],
      decisions_applied: ["dec-01"],
      deviations: [{ decision_id: "dec-02", reason: "test reason" }],
      tests_added: ["src/__tests__/a.test.ts"],
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

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "new-slug",
      task_id: "t-01",
      files_changed: [],
    });

    assertOk(result);
    expect(result.path).toContain("new-slug");
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("writeImplementationSummary — validation errors", () => {
  it("returns INVALID_INPUT for invalid slug (spaces)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "invalid slug",
      task_id: "task-01",
      files_changed: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("invalid slug");
    }
  });

  it("returns INVALID_INPUT for invalid slug (special chars)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "my/epic!",
      task_id: "task-01",
      files_changed: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for invalid task_id (spaces)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task 01",
      files_changed: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("task 01");
    }
  });

  it("returns INVALID_INPUT for invalid task_id (special chars)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task@01!",
      files_changed: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for path traversal in slug", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-test-"));

    const result = await writeImplementationSummary({
      workspace: tmpDir,
      slug: "../evil",
      task_id: "task-01",
      files_changed: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});
