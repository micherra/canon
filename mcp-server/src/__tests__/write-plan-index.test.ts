import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { writePlanIndex } from "../tools/write-plan-index.ts";
import { parseTaskIdsForWave } from "../orchestration/wave-variables.ts";
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

describe("writePlanIndex — valid input", () => {
  it("creates INDEX.md and returns path, task_count, wave_count", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "my-epic",
      tasks: [
        { task_id: "task-01", wave: 1 },
        { task_id: "task-02", wave: 1 },
        { task_id: "task-03", wave: 2 },
      ],
    });

    assertOk(result);
    expect(result.task_count).toBe(3);
    expect(result.wave_count).toBe(2);
    expect(result.path).toContain("INDEX.md");
    expect(result.path).toContain("my-epic");
  });

  it("writes a parseable markdown table", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "my-epic",
      tasks: [
        { task_id: "task-01", wave: 1, depends_on: ["task-00"], files: ["src/foo.ts"], principles: ["thin-handlers"] },
        { task_id: "task-02", wave: 2 },
      ],
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

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "new-slug",
      tasks: [{ task_id: "t-01", wave: 1 }],
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("t-01");
  });

  it("handles optional fields (depends_on, files, principles)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "test-slug",
      tasks: [
        {
          task_id: "t-01",
          wave: 1,
          depends_on: ["prereq-01"],
          files: ["src/a.ts", "src/b.ts"],
          principles: ["errors-are-values"],
        },
      ],
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("prereq-01");
    expect(content).toContain("src/a.ts");
    expect(content).toContain("errors-are-values");
  });

  it("wave_count is 1 when all tasks are in the same wave", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "single-wave",
      tasks: [
        { task_id: "t-01", wave: 3 },
        { task_id: "t-02", wave: 3 },
      ],
    });

    assertOk(result);
    expect(result.wave_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("writePlanIndex — validation errors", () => {
  it("returns INVALID_INPUT for task_id with spaces", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "my-epic",
      tasks: [{ task_id: "task with spaces", wave: 1 }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("task with spaces");
    }
  });

  it("returns INVALID_INPUT for task_id with special chars", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "my-epic",
      tasks: [{ task_id: "task@01!", wave: 1 }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for duplicate task IDs", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "my-epic",
      tasks: [
        { task_id: "task-01", wave: 1 },
        { task_id: "task-01", wave: 2 },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("task-01");
    }
  });

  it("returns INVALID_INPUT for wave < 1", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "my-epic",
      tasks: [{ task_id: "task-01", wave: 0 }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("wave");
    }
  });

  it("returns INVALID_INPUT for negative wave", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "my-epic",
      tasks: [{ task_id: "task-01", wave: -1 }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip test: writePlanIndex output parsed by parseTaskIdsForWave
// ---------------------------------------------------------------------------

describe("writePlanIndex — round-trip with parseTaskIdsForWave", () => {
  it("written INDEX.md can be parsed back by parseTaskIdsForWave for wave 1", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "roundtrip-test",
      tasks: [
        { task_id: "adr004-01", wave: 1 },
        { task_id: "adr004-02", wave: 1 },
        { task_id: "adr004-03", wave: 2 },
        { task_id: "adr004-04", wave: 2, depends_on: ["adr004-01"] },
      ],
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");

    const wave1Ids = parseTaskIdsForWave(content, 1);
    const wave2Ids = parseTaskIdsForWave(content, 2);

    expect(wave1Ids).toEqual(["adr004-01", "adr004-02"]);
    expect(wave2Ids).toEqual(["adr004-03", "adr004-04"]);
  });

  it("round-trip preserves all task IDs (none lost during write/parse)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const tasks = [
      { task_id: "t-01", wave: 1 },
      { task_id: "t-02", wave: 1 },
      { task_id: "t-03", wave: 2 },
      { task_id: "t-04", wave: 3 },
      { task_id: "t-05", wave: 3 },
    ];

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "full-roundtrip",
      tasks,
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");

    const allParsed = [
      ...parseTaskIdsForWave(content, 1),
      ...parseTaskIdsForWave(content, 2),
      ...parseTaskIdsForWave(content, 3),
    ];

    const expectedIds = tasks.map((t) => t.task_id);
    expect(allParsed.sort()).toEqual(expectedIds.sort());
  });

  it("task IDs with hyphens and underscores round-trip correctly", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "id-format-test",
      tasks: [
        { task_id: "my-task_01", wave: 1 },
        { task_id: "CamelCase-01", wave: 1 },
        { task_id: "ALL_CAPS_ID", wave: 2 },
      ],
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");

    expect(parseTaskIdsForWave(content, 1)).toEqual(["my-task_01", "CamelCase-01"]);
    expect(parseTaskIdsForWave(content, 2)).toEqual(["ALL_CAPS_ID"]);
  });
});
