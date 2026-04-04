import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDesignBrief } from "../tools/write-design-brief.ts";
import { assertOk } from "../utils/tool-result.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("writeDesignBrief — valid input", () => {
  it("writes DESIGN-BRIEF.md and DESIGN-BRIEF.meta.json to handoffs directory", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task-01",
      file_targets: [
        { path: "src/tools/foo.ts", action: "create", description: "New tool" },
      ],
      constraints: ["Max 60 lines per function"],
      test_expectations: [
        { description: "happy path creates file", file: "src/__tests__/foo.test.ts" },
      ],
    });

    assertOk(result);
    expect(result.path).toContain("DESIGN-BRIEF.md");
    expect(result.path).toContain("handoffs");
    expect(result.meta_path).toContain("DESIGN-BRIEF.meta.json");
    expect(result.meta_path).toContain("handoffs");
    expect(result.file_target_count).toBe(1);
    expect(result.constraint_count).toBe(1);

    const md = await readFile(result.path, "utf-8");
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(md).toBeTruthy();
    expect(meta).toBeTruthy();
  });

  it("meta JSON has _type: design_brief, _version: 1, and task_id", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task-02",
      file_targets: [],
      constraints: [],
      test_expectations: [],
    });

    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta._type).toBe("design_brief");
    expect(meta._version).toBe(1);
    expect(meta.task_id).toBe("task-02");
  });

  it("markdown contains File Targets section with path, action, description columns", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "test-epic",
      task_id: "task-01",
      file_targets: [
        { path: "src/a.ts", action: "create", description: "Brand new" },
        { path: "src/b.ts", action: "modify" },
        { path: "src/c.ts", action: "delete", description: "Remove it" },
      ],
      constraints: [],
      test_expectations: [],
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("File Targets");
    expect(content).toContain("src/a.ts");
    expect(content).toContain("create");
    expect(content).toContain("Brand new");
    expect(content).toContain("src/b.ts");
    expect(content).toContain("modify");
    expect(content).toContain("src/c.ts");
    expect(content).toContain("delete");
    expect(content).toContain("Remove it");
    // Missing description renders as em-dash
    expect(content).toContain("—");
  });

  it("markdown contains Constraints section", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "test-epic",
      task_id: "task-01",
      file_targets: [],
      constraints: ["Use TypeScript strict mode", "No any types"],
      test_expectations: [],
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("Constraints");
    expect(content).toContain("Use TypeScript strict mode");
    expect(content).toContain("No any types");
  });

  it("markdown contains Test Expectations section with description and file columns", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "test-epic",
      task_id: "task-01",
      file_targets: [],
      constraints: [],
      test_expectations: [
        { description: "creates output file", file: "src/__tests__/foo.test.ts" },
        { description: "returns INVALID_INPUT on bad slug" },
      ],
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("Test Expectations");
    expect(content).toContain("creates output file");
    expect(content).toContain("src/__tests__/foo.test.ts");
    expect(content).toContain("returns INVALID_INPUT on bad slug");
    // Missing file renders as em-dash
    expect(content).toContain("—");
  });

  it("returns correct file_target_count and constraint_count", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task-01",
      file_targets: [
        { path: "a.ts", action: "create" },
        { path: "b.ts", action: "modify" },
        { path: "c.ts", action: "delete" },
      ],
      constraints: ["c1", "c2"],
      test_expectations: [],
    });

    assertOk(result);
    expect(result.file_target_count).toBe(3);
    expect(result.constraint_count).toBe(2);
  });

  it("creates the handoffs directory if it does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "new-slug",
      task_id: "t-01",
      file_targets: [],
      constraints: [],
      test_expectations: [],
    });

    assertOk(result);
    expect(result.path).toContain("handoffs");
  });
});

// ---------------------------------------------------------------------------
// Optional fields absent — corresponding sections should not appear
// ---------------------------------------------------------------------------

describe("writeDesignBrief — optional fields absent", () => {
  it("omits Decisions Referenced section when not provided", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task-01",
      file_targets: [],
      constraints: [],
      test_expectations: [],
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).not.toContain("Decisions Referenced");

    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta.decisions_referenced).toBeUndefined();
  });

  it("omits Dependencies section when not provided", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task-01",
      file_targets: [],
      constraints: [],
      test_expectations: [],
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).not.toContain("Dependencies");

    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta.dependencies).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Optional fields present — corresponding sections appear
// ---------------------------------------------------------------------------

describe("writeDesignBrief — optional fields present", () => {
  it("includes Decisions Referenced section when provided", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task-01",
      file_targets: [],
      constraints: [],
      test_expectations: [],
      decisions_referenced: ["dec-001", "dec-005"],
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("Decisions Referenced");
    expect(content).toContain("dec-001");
    expect(content).toContain("dec-005");

    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta.decisions_referenced).toEqual(["dec-001", "dec-005"]);
  });

  it("includes Dependencies section when provided", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task-01",
      file_targets: [],
      constraints: [],
      test_expectations: [],
      dependencies: ["task-00", "task-03"],
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("Dependencies");
    expect(content).toContain("task-00");
    expect(content).toContain("task-03");

    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta.dependencies).toEqual(["task-00", "task-03"]);
  });

  it("all optional fields included in markdown and meta", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "full-epic",
      task_id: "full-task-01",
      file_targets: [{ path: "src/a.ts", action: "create" }],
      constraints: ["constraint-one"],
      test_expectations: [{ description: "passes", file: "src/__tests__/a.test.ts" }],
      decisions_referenced: ["dec-01"],
      dependencies: ["task-00"],
    });

    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta._type).toBe("design_brief");
    expect(meta._version).toBe(1);
    expect(meta.task_id).toBe("full-task-01");
    expect(meta.slug).toBe("full-epic");
    expect(meta.file_targets).toHaveLength(1);
    expect(meta.constraints).toEqual(["constraint-one"]);
    expect(meta.test_expectations).toHaveLength(1);
    expect(meta.decisions_referenced).toEqual(["dec-01"]);
    expect(meta.dependencies).toEqual(["task-00"]);
    expect(result.file_target_count).toBe(1);
    expect(result.constraint_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("writeDesignBrief — validation errors", () => {
  it("returns INVALID_INPUT for invalid slug (spaces)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "invalid slug",
      task_id: "task-01",
      file_targets: [],
      constraints: [],
      test_expectations: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("invalid slug");
    }
  });

  it("returns INVALID_INPUT for invalid slug (special chars)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "my/epic!",
      task_id: "task-01",
      file_targets: [],
      constraints: [],
      test_expectations: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for invalid task_id (spaces)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task 01",
      file_targets: [],
      constraints: [],
      test_expectations: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("task 01");
    }
  });

  it("returns INVALID_INPUT for invalid task_id (special chars)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "my-epic",
      task_id: "task@01!",
      file_targets: [],
      constraints: [],
      test_expectations: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for path traversal attempt in slug (../ pattern)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-brief-test-"));

    // The slug pattern validation catches this before path traversal check
    const result = await writeDesignBrief({
      workspace: tmpDir,
      slug: "../evil",
      task_id: "task-01",
      file_targets: [],
      constraints: [],
      test_expectations: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});
