import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock ../adapters/git-adapter.ts before importing the module under test
// so that wave_diff tests can control gitExec behavior.
vi.mock("../adapters/git-adapter.ts", () => ({
  gitExec: vi.fn(),
}));

import { gitExec } from "../adapters/git-adapter.ts";
import {
  escapeDollarBrace,
  extractFilePaths,
  parseTaskIdsForWave,
  resolveWaveVariables,
} from "../orchestration/wave-variables.ts";

const mockGitExec = vi.mocked(gitExec);

// ---------------------------------------------------------------------------
// escapeDollarBrace — pure function, no I/O
// ---------------------------------------------------------------------------

describe("escapeDollarBrace", () => {
  it("escapes ${foo} to \\${foo}", () => {
    expect(escapeDollarBrace("hello ${foo} world")).toBe("hello \\${foo} world");
  });

  it("escapes multiple occurrences", () => {
    expect(escapeDollarBrace("${a} and ${b}")).toBe("\\${a} and \\${b}");
  });

  it("leaves regular text unchanged", () => {
    expect(escapeDollarBrace("no dollar brace here")).toBe("no dollar brace here");
  });

  it("handles empty string", () => {
    expect(escapeDollarBrace("")).toBe("");
  });

  it("leaves $ without brace unchanged", () => {
    expect(escapeDollarBrace("$100 and $200")).toBe("$100 and $200");
  });

  it("escapes the ${ inside a previously-escaped pattern (no lookbehind guard)", () => {
    // The function replaces ALL `${` occurrences, including ones after `\`.
    // This is by design — the escape is additive, not idempotent.
    // The string `\${x}` contains `${`, so it becomes `\\\${x}`.
    const input = "\\${already_escaped}";
    // `\${` matches the regex, so it becomes `\\${` → i.e. one extra backslash
    expect(escapeDollarBrace(input)).toBe("\\\\${already_escaped}");
  });
});

// ---------------------------------------------------------------------------
// parseTaskIdsForWave — pure parsing helper
// ---------------------------------------------------------------------------

describe("parseTaskIdsForWave", () => {
  const indexContent = `## Plan Index

| Task | Wave | Depends on | Files | Principles |
|------|------|------------|-------|------------|
| iwc-01 | 1 | -- | wave-variables.ts | functions-do-one-thing |
| iwc-02 | 1 | -- | gate-runner.ts | validate-at-trust-boundaries |
| iwc-03 | 2 | iwc-01 | board.ts | prefer-immutable-data |
| iwc-04 | 2 | iwc-02 | consultation.ts | handle-partial-failure |
`;

  it("returns task IDs for wave 1", () => {
    expect(parseTaskIdsForWave(indexContent, 1)).toEqual(["iwc-01", "iwc-02"]);
  });

  it("returns task IDs for wave 2", () => {
    expect(parseTaskIdsForWave(indexContent, 2)).toEqual(["iwc-03", "iwc-04"]);
  });

  it("returns empty array when no tasks for that wave", () => {
    expect(parseTaskIdsForWave(indexContent, 99)).toEqual([]);
  });

  it("skips header rows", () => {
    const result = parseTaskIdsForWave(indexContent, 1);
    expect(result).not.toContain("Task");
  });

  it("handles backtick-wrapped task IDs: | `task-01` | 1 |", () => {
    const backtickContent = `## Plan Index

| Task | Wave | Depends on | Files | Principles |
|------|------|------------|-------|------------|
| \`adr004-01\` | 1 | — |  |  |
| \`adr004-02\` | 1 | — |  |  |
| \`adr004-03\` | 2 | adr004-01 |  |  |
`;
    expect(parseTaskIdsForWave(backtickContent, 1)).toEqual(["adr004-01", "adr004-02"]);
    expect(parseTaskIdsForWave(backtickContent, 2)).toEqual(["adr004-03"]);
  });

  it("handles plain (no-backtick) task IDs as regression test", () => {
    const plainContent = `## Plan Index

| Task | Wave | Depends on |
|------|------|------------|
| plain-01 | 1 | — |
| plain-02 | 2 | plain-01 |
`;
    expect(parseTaskIdsForWave(plainContent, 1)).toEqual(["plain-01"]);
    expect(parseTaskIdsForWave(plainContent, 2)).toEqual(["plain-02"]);
  });

  it("skips separator row (--- in table)", () => {
    const contentWithSep = `| Task | Wave |
|------|------|
| real-01 | 1 |
`;
    const result = parseTaskIdsForWave(contentWithSep, 1);
    expect(result).toEqual(["real-01"]);
    expect(result).not.toContain("---");
  });
});

// ---------------------------------------------------------------------------
// extractFilePaths — pure parsing helper
// ---------------------------------------------------------------------------

describe("extractFilePaths", () => {
  it("extracts backtick-quoted paths", () => {
    const content = "Modified `src/orchestration/wave-variables.ts` and `mcp-server/src/index.ts`";
    const paths = extractFilePaths(content);
    expect(paths).toContain("src/orchestration/wave-variables.ts");
    expect(paths).toContain("mcp-server/src/index.ts");
  });

  it("extracts paths from markdown table rows", () => {
    const content = "| `mcp-server/src/tools/load-flow.ts` | created | Load flows |";
    const paths = extractFilePaths(content);
    expect(paths).toContain("mcp-server/src/tools/load-flow.ts");
  });

  it("returns empty array when no paths found", () => {
    expect(extractFilePaths("no file paths here, just words")).toEqual([]);
  });

  it("deduplicates paths that appear multiple times", () => {
    const content = "`src/foo/bar.ts` and `src/foo/bar.ts` again";
    const paths = extractFilePaths(content);
    expect(paths.filter((p) => p === "src/foo/bar.ts")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolveWaveVariables — filesystem integration tests
// ---------------------------------------------------------------------------

describe("resolveWaveVariables", () => {
  let tmpDir: string;
  let plansDir: string;
  const slug = "my-task";

  // Default gitExec mock: successful empty diff
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wave-variables-test-"));
    plansDir = join(tmpDir, "plans", slug);
    await mkdir(plansDir, { recursive: true });

    // Default: successful git diff returning empty output
    mockGitExec.mockReturnValue({
      ok: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      duration_ms: 0,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // Helper: create INDEX.md with one wave-1 task
  async function writeIndex(rows: Array<{ id: string; wave: number }>) {
    const header = `## Plan Index\n\n| Task | Wave | Depends on | Files | Principles |\n|------|------|------------|-------|------------|\n`;
    const body = rows.map((r) => `| ${r.id} | ${r.wave} | -- | file.ts | some-principle |`).join("\n");
    await writeFile(join(plansDir, "INDEX.md"), `${header + body}\n`);
  }

  // ------------------------------------------------------------------
  // wave_plans
  // ------------------------------------------------------------------

  it("wave_plans: populates with current wave plan files", async () => {
    await writeIndex([{ id: "iwc-01", wave: 1 }]);
    await writeFile(join(plansDir, "iwc-01-PLAN.md"), "# Plan for iwc-01\nDo something.");

    const vars = await resolveWaveVariables(tmpDir, 1, slug, 2);

    expect(vars.wave_plans).toContain("# Plan for iwc-01");
    expect(vars.wave_plans).toContain("Do something.");
  });

  it("wave_plans: concatenates multiple plan files", async () => {
    await writeIndex([
      { id: "iwc-01", wave: 1 },
      { id: "iwc-02", wave: 1 },
    ]);
    await writeFile(join(plansDir, "iwc-01-PLAN.md"), "Plan A content.");
    await writeFile(join(plansDir, "iwc-02-PLAN.md"), "Plan B content.");

    const vars = await resolveWaveVariables(tmpDir, 1, slug, 2);

    expect(vars.wave_plans).toContain("Plan A content.");
    expect(vars.wave_plans).toContain("Plan B content.");
  });

  // ------------------------------------------------------------------
  // wave_summaries
  // ------------------------------------------------------------------

  it("wave_summaries: is empty string for wave 1 (no prior wave)", async () => {
    await writeIndex([{ id: "iwc-01", wave: 1 }]);

    const vars = await resolveWaveVariables(tmpDir, 1, slug, 2);

    expect(vars.wave_summaries).toBe("");
  });

  it("wave_summaries: populates from previous wave summaries for wave 2+", async () => {
    await writeIndex([
      { id: "iwc-01", wave: 1 },
      { id: "iwc-02", wave: 2 },
    ]);
    await writeFile(join(plansDir, "iwc-01-SUMMARY.md"), "# Summary for iwc-01\nCompleted work.");
    await writeFile(join(plansDir, "iwc-02-PLAN.md"), "# Plan for iwc-02");

    const vars = await resolveWaveVariables(tmpDir, 2, slug, 2);

    expect(vars.wave_summaries).toContain("# Summary for iwc-01");
    expect(vars.wave_summaries).toContain("Completed work.");
  });

  // ------------------------------------------------------------------
  // wave_files
  // ------------------------------------------------------------------

  it("wave_files: is empty string for wave 1", async () => {
    await writeIndex([{ id: "iwc-01", wave: 1 }]);

    const vars = await resolveWaveVariables(tmpDir, 1, slug, 2);

    expect(vars.wave_files).toBe("");
  });

  it("wave_files: extracts file paths from previous wave summaries", async () => {
    await writeIndex([
      { id: "iwc-01", wave: 1 },
      { id: "iwc-02", wave: 2 },
    ]);
    const summary = [
      "## Files",
      "| `mcp-server/src/orchestration/wave-variables.ts` | created | Core logic |",
      "| `mcp-server/src/__tests__/wave-variables.test.ts` | created | Tests |",
    ].join("\n");
    await writeFile(join(plansDir, "iwc-01-SUMMARY.md"), summary);
    await writeFile(join(plansDir, "iwc-02-PLAN.md"), "# Plan");

    const vars = await resolveWaveVariables(tmpDir, 2, slug, 2);

    expect(vars.wave_files).toContain("mcp-server/src/orchestration/wave-variables.ts");
    expect(vars.wave_files).toContain("mcp-server/src/__tests__/wave-variables.test.ts");
  });

  // ------------------------------------------------------------------
  // wave_diff
  // ------------------------------------------------------------------

  it("wave_diff: returns git diff output when gitExec succeeds", async () => {
    await writeIndex([{ id: "iwc-01", wave: 1 }]);
    mockGitExec.mockReturnValue({
      ok: true,
      stdout: "diff --git a/foo.ts b/foo.ts\n+added line",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      duration_ms: 0,
    });

    const vars = await resolveWaveVariables(tmpDir, 1, slug, 1);

    expect(vars.wave_diff).toContain("diff --git a/foo.ts b/foo.ts");
    expect(vars.wave_diff).toContain("+added line");
  });

  it("wave_diff: returns empty string when gitExec returns ok: false (non-zero status)", async () => {
    await writeIndex([{ id: "iwc-01", wave: 1 }]);
    mockGitExec.mockReturnValue({
      ok: false,
      stdout: "",
      stderr: "fatal: not a git repository",
      exitCode: 128,
      timedOut: false,
      duration_ms: 0,
    });

    const vars = await resolveWaveVariables(tmpDir, 1, slug, 1);

    expect(vars.wave_diff).toBe("");
  });

  it("wave_diff: returns empty string when gitExec times out (timedOut: true)", async () => {
    // Risk mitigation: adapter timeout → graceful degradation to empty string
    await writeIndex([{ id: "iwc-01", wave: 1 }]);
    mockGitExec.mockReturnValue({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: 1,
      timedOut: true,
      duration_ms: 0,
    });

    const vars = await resolveWaveVariables(tmpDir, 1, slug, 1);

    expect(vars.wave_diff).toBe("");
  });

  it("wave_diff: calls gitExec with diff HEAD~1 args", async () => {
    await writeIndex([{ id: "iwc-01", wave: 1 }]);
    mockGitExec.mockReturnValue({ ok: true, stdout: "", stderr: "", exitCode: 0, timedOut: false, duration_ms: 0 });

    await resolveWaveVariables(tmpDir, 1, slug, 1);

    expect(mockGitExec).toHaveBeenCalledWith(["diff", "HEAD~1"], expect.any(String));
  });

  // ------------------------------------------------------------------
  // all_summaries
  // ------------------------------------------------------------------

  it("all_summaries: concatenates summaries from all waves", async () => {
    await writeIndex([
      { id: "iwc-01", wave: 1 },
      { id: "iwc-02", wave: 2 },
    ]);
    await writeFile(join(plansDir, "iwc-01-SUMMARY.md"), "Wave 1 summary.");
    await writeFile(join(plansDir, "iwc-02-SUMMARY.md"), "Wave 2 summary.");

    const vars = await resolveWaveVariables(tmpDir, 2, slug, 2);

    expect(vars.all_summaries).toContain("Wave 1 summary.");
    expect(vars.all_summaries).toContain("Wave 2 summary.");
  });

  it("all_summaries: silently skips tasks with no summary file yet", async () => {
    await writeIndex([
      { id: "iwc-01", wave: 1 },
      { id: "iwc-02", wave: 2 },
    ]);
    await writeFile(join(plansDir, "iwc-01-SUMMARY.md"), "Wave 1 done.");
    // iwc-02 has no summary yet

    const vars = await resolveWaveVariables(tmpDir, 2, slug, 2);

    expect(vars.all_summaries).toContain("Wave 1 done.");
    // No throw, just partial results
  });

  // ------------------------------------------------------------------
  // Partial failure / graceful degradation
  // ------------------------------------------------------------------

  it("returns partial result without throwing when summary files are missing", async () => {
    await writeIndex([
      { id: "iwc-01", wave: 1 },
      { id: "iwc-02", wave: 2 },
    ]);
    // iwc-01-SUMMARY.md does NOT exist

    let result: Record<string, string> | undefined;
    await expect(
      resolveWaveVariables(tmpDir, 2, slug, 2).then((r) => {
        result = r;
        return r;
      }),
    ).resolves.toBeDefined();

    // wave_summaries is empty (missing file, graceful degradation)
    expect(result?.wave_summaries).toBe("");
  });

  it("returns an object with all five keys even on total failure", async () => {
    // No INDEX.md, no plan files — everything fails gracefully
    const vars = await resolveWaveVariables(tmpDir, 1, slug, 1);

    expect(vars).toHaveProperty("wave_plans");
    expect(vars).toHaveProperty("wave_summaries");
    expect(vars).toHaveProperty("wave_files");
    expect(vars).toHaveProperty("wave_diff");
    expect(vars).toHaveProperty("all_summaries");
  });

  // ------------------------------------------------------------------
  // Prompt injection prevention
  // ------------------------------------------------------------------

  it("escapes ${...} patterns in summary content (prompt injection prevention)", async () => {
    await writeIndex([
      { id: "iwc-01", wave: 1 },
      { id: "iwc-02", wave: 2 },
    ]);
    const maliciousSummary = "Summary with ${dangerous_var} injection attempt and ${another_var}";
    await writeFile(join(plansDir, "iwc-01-SUMMARY.md"), maliciousSummary);
    await writeFile(join(plansDir, "iwc-02-PLAN.md"), "# Plan");

    const vars = await resolveWaveVariables(tmpDir, 2, slug, 2);

    // The ${...} patterns must be escaped — every ${ must be preceded by backslash.
    // We verify this by checking no unescaped ${ exists (i.e., ${ not preceded by \)
    expect(vars.wave_summaries).toMatch(/\\\$\{dangerous_var\}/);
    expect(vars.wave_summaries).toMatch(/\\\$\{another_var\}/);
    // No bare ${ (preceded by non-backslash or at start)
    expect(vars.wave_summaries).not.toMatch(/(^|[^\\])\$\{/m);
  });

  it("escapes ${...} patterns in plan content", async () => {
    await writeIndex([{ id: "iwc-01", wave: 1 }]);
    await writeFile(join(plansDir, "iwc-01-PLAN.md"), "Run: echo ${PATH} and ${HOME}");

    const vars = await resolveWaveVariables(tmpDir, 1, slug, 1);

    expect(vars.wave_plans).toMatch(/\\\$\{PATH\}/);
    expect(vars.wave_plans).not.toMatch(/(^|[^\\])\$\{PATH\}/m);
  });

  it("escapes ${...} in git diff output (prompt injection via diff)", async () => {
    await writeIndex([{ id: "iwc-01", wave: 1 }]);
    mockGitExec.mockReturnValue({
      ok: true,
      stdout: "+const x = `${injected_variable}`;",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      duration_ms: 0,
    });

    const vars = await resolveWaveVariables(tmpDir, 1, slug, 1);

    expect(vars.wave_diff).toMatch(/\\\$\{injected_variable\}/);
    expect(vars.wave_diff).not.toMatch(/(^|[^\\])\$\{injected_variable\}/m);
  });
});
