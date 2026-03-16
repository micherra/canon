import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { logRalph } from "../tools/log-ralph.js";

describe("logRalph()", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-log-ralph-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function readJsonl<T>(filePath: string): Promise<T[]> {
    const content = await readFile(filePath, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as T);
  }

  it("records a converged ralph loop", async () => {
    const result = await logRalph(
      {
        task_slug: "add-auth",
        iterations: [
          {
            iteration: 1,
            verdict: "WARNING",
            violations_count: 3,
            violations_fixed: 2,
            cannot_fix: 0,
          },
          {
            iteration: 2,
            verdict: "CLEAN",
            violations_count: 1,
            violations_fixed: 1,
            cannot_fix: 0,
          },
        ],
        final_verdict: "CLEAN",
        converged: true,
        team: ["canon-reviewer", "canon-refactorer"],
      },
      tmpDir
    );

    expect(result.recorded).toBe(true);
    expect(result.id).toMatch(/^ralph_\d{8}_[0-9a-f]{4}$/);
    expect(result.note).toContain("Converged");

    const entries = await readJsonl<any>(
      join(tmpDir, ".canon", "ralph-loops.jsonl")
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].loop_id).toBe(result.id);
    expect(entries[0].task_slug).toBe("add-auth");
    expect(entries[0].converged).toBe(true);
    expect(entries[0].iterations).toHaveLength(2);
  });

  it("records a non-converged ralph loop", async () => {
    const result = await logRalph(
      {
        task_slug: "complex-refactor",
        iterations: [
          {
            iteration: 1,
            verdict: "BLOCKING",
            violations_count: 5,
            violations_fixed: 2,
            cannot_fix: 1,
          },
          {
            iteration: 2,
            verdict: "WARNING",
            violations_count: 3,
            violations_fixed: 1,
            cannot_fix: 1,
          },
          {
            iteration: 3,
            verdict: "WARNING",
            violations_count: 2,
            violations_fixed: 0,
            cannot_fix: 2,
          },
        ],
        final_verdict: "WARNING",
        converged: false,
        team: ["canon-reviewer", "canon-refactorer", "canon-security"],
      },
      tmpDir
    );

    expect(result.recorded).toBe(true);
    expect(result.note).toContain("Stopped");

    const entries = await readJsonl<any>(
      join(tmpDir, ".canon", "ralph-loops.jsonl")
    );
    expect(entries[0].converged).toBe(false);
    expect(entries[0].final_verdict).toBe("WARNING");
    expect(entries[0].team).toEqual([
      "canon-reviewer",
      "canon-refactorer",
      "canon-security",
    ]);
  });

  it("generates unique IDs for each loop", async () => {
    const result1 = await logRalph(
      {
        task_slug: "task-1",
        iterations: [
          {
            iteration: 1,
            verdict: "CLEAN",
            violations_count: 0,
            violations_fixed: 0,
            cannot_fix: 0,
          },
        ],
        final_verdict: "CLEAN",
        converged: true,
        team: ["canon-reviewer"],
      },
      tmpDir
    );

    const result2 = await logRalph(
      {
        task_slug: "task-2",
        iterations: [
          {
            iteration: 1,
            verdict: "CLEAN",
            violations_count: 0,
            violations_fixed: 0,
            cannot_fix: 0,
          },
        ],
        final_verdict: "CLEAN",
        converged: true,
        team: ["canon-reviewer"],
      },
      tmpDir
    );

    expect(result1.id).not.toBe(result2.id);

    const entries = await readJsonl<any>(
      join(tmpDir, ".canon", "ralph-loops.jsonl")
    );
    expect(entries).toHaveLength(2);
  });
});
