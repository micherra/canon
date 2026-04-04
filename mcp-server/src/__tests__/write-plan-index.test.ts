import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTaskIdsForWave } from "../orchestration/wave-variables.ts";
import { writePlanIndex } from "../tools/write-plan-index.ts";
import { assertOk } from "../utils/tool-result.ts";

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

describe("writePlanIndex — validation errors", () => {
  it("returns INVALID_INPUT for task_id with spaces", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

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

// Round-trip test: writePlanIndex output parsed by parseTaskIdsForWave

describe("writePlanIndex — round-trip with parseTaskIdsForWave", () => {
  it("written INDEX.md can be parsed back by parseTaskIdsForWave for wave 1", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));

    const result = await writePlanIndex({
      slug: "roundtrip-test",
      tasks: [
        { task_id: "adr004-01", wave: 1 },
        { task_id: "adr004-02", wave: 1 },
        { task_id: "adr004-03", wave: 2 },
        { depends_on: ["adr004-01"], task_id: "adr004-04", wave: 2 },
      ],
      workspace: tmpDir,
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
      slug: "full-roundtrip",
      tasks,
      workspace: tmpDir,
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
      slug: "id-format-test",
      tasks: [
        { task_id: "my-task_01", wave: 1 },
        { task_id: "CamelCase-01", wave: 1 },
        { task_id: "ALL_CAPS_ID", wave: 2 },
      ],
      workspace: tmpDir,
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");

    expect(parseTaskIdsForWave(content, 1)).toEqual(["my-task_01", "CamelCase-01"]);
    expect(parseTaskIdsForWave(content, 2)).toEqual(["ALL_CAPS_ID"]);
  });
});

// ADR-004 acceptance: write_plan_index + parseTaskIdsForWave (dc-05, dc-06)

describe("ADR-004 acceptance: write_plan_index round-trip (dc-05)", () => {
  it("produces INDEX.md that parseTaskIdsForWave can parse for multi-wave plans", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-test-"));

    const result = await writePlanIndex({
      slug: "test-slug",
      tasks: [
        { files: ["a.ts"], task_id: "t-01", wave: 1 },
        { files: ["b.ts"], task_id: "t-02", wave: 1 },
        { depends_on: ["t-01", "t-02"], task_id: "t-03", wave: 2 },
      ],
      workspace: tmpDir,
    });

    assertOk(result);
    const content = await readFile(result.path, "utf-8");

    const wave1 = parseTaskIdsForWave(content, 1);
    const wave2 = parseTaskIdsForWave(content, 2);

    expect(wave1).toEqual(["t-01", "t-02"]);
    expect(wave2).toEqual(["t-03"]);
  });
});

describe("ADR-004 acceptance: parseTaskIdsForWave zero-task guard (dc-06)", () => {
  it("returns empty array when INDEX.md has no tasks for the requested wave (zero-task guard)", () => {
    // The zero-task guard: parseTaskIdsForWave returns [] when the requested wave
    // has no entries — callers must handle this to avoid spawning zero agents.
    const content = `## Plan Index: test\n\n| Task | Wave |\n|------|------|\n| t-01 | 1 |\n`;
    expect(parseTaskIdsForWave(content, 2)).toEqual([]);
    expect(parseTaskIdsForWave(content, 99)).toEqual([]);
  });

  it("returns empty array for completely empty INDEX.md content", () => {
    expect(parseTaskIdsForWave("", 1)).toEqual([]);
  });

  it("writePlanIndex with empty tasks array produces parseable INDEX.md with wave_count 0", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-test-"));

    const result = await writePlanIndex({
      slug: "empty-slug",
      tasks: [],
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.task_count).toBe(0);
    expect(result.wave_count).toBe(0);

    const content = await readFile(result.path, "utf-8");
    // No tasks in any wave
    expect(parseTaskIdsForWave(content, 1)).toEqual([]);
  });
});
