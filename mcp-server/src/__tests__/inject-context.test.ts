import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { resolveContextInjections, extractSection } from "../orchestration/inject-context.ts";
import type { Board, ContextInjection } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBoard(stateOverrides: Board["states"] = {}): Board {
  return {
    flow: "test",
    task: "test task",
    entry: "start",
    current_state: "start",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: stateOverrides,
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
  };
}

// ---------------------------------------------------------------------------
// extractSection — pure function, no filesystem
// ---------------------------------------------------------------------------

describe("extractSection", () => {
  it("returns null for empty markdown", () => {
    expect(extractSection("", "Summary")).toBeNull();
  });

  it("returns null when section heading is not found", () => {
    const md = "# Introduction\nSome text.\n## Details\nMore text.";
    expect(extractSection(md, "Missing")).toBeNull();
  });

  it("extracts content under the matching heading", () => {
    const md = "# Summary\nThis is the summary.\n\n# Next Section\nOther content.";
    const result = extractSection(md, "Summary");
    expect(result).toBe("# Summary\nThis is the summary.");
  });

  it("extracts full section until same-level heading", () => {
    const md = "## Alpha\nAlpha text.\n## Beta\nBeta text.";
    const result = extractSection(md, "Alpha");
    expect(result).toBe("## Alpha\nAlpha text.");
  });

  it("extracts full section until higher-level heading", () => {
    const md = "### Details\nDetail content.\n## Parent\nParent content.";
    const result = extractSection(md, "Details");
    expect(result).toBe("### Details\nDetail content.");
  });

  it("includes nested subheadings within the section", () => {
    const md = "## Overview\nIntro.\n### Part A\nPart A content.\n### Part B\nPart B content.\n## Next\nDone.";
    const result = extractSection(md, "Overview");
    expect(result).toContain("### Part A");
    expect(result).toContain("### Part B");
    expect(result).not.toContain("## Next");
  });

  it("is case-insensitive for section name matching", () => {
    const md = "## MY SECTION\nContent here.";
    expect(extractSection(md, "my section")).toBe("## MY SECTION\nContent here.");
    expect(extractSection(md, "My Section")).toBe("## MY SECTION\nContent here.");
  });

  it("handles section at end of document (no following heading)", () => {
    const md = "## Last Section\nFinal content.";
    const result = extractSection(md, "Last Section");
    expect(result).toBe("## Last Section\nFinal content.");
  });

  it("returns null when heading text includes trailing punctuation that doesn't match", () => {
    const md = "## Summary!\nContent.";
    // The heading text is "Summary!" and the search is "Summary" — no match
    expect(extractSection(md, "Summary")).toBeNull();
  });

  it("handles multiple levels of nesting", () => {
    const md = "# Root\n## Child\n### Grandchild\nDeep content.\n## Sibling\nSibling content.";
    const child = extractSection(md, "Child");
    expect(child).toContain("### Grandchild");
    expect(child).toContain("Deep content.");
    expect(child).not.toContain("Sibling content.");
  });
});

// ---------------------------------------------------------------------------
// resolveContextInjections — filesystem interactions
// ---------------------------------------------------------------------------

describe("resolveContextInjections", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "inject-context-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads artifact from a state and assigns to variable", async () => {
    const artifactPath = join(tmpDir, "output.md");
    await writeFile(artifactPath, "# Summary\nThis is important output.");

    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: [artifactPath] },
    });
    const injections: ContextInjection[] = [
      { from: "research", as: "RESEARCH_OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(0);
    expect(result.hitl).toBeUndefined();
    expect(result.variables["RESEARCH_OUTPUT"]).toContain("This is important output.");
  });

  it("extracts a named section from artifact content", async () => {
    const artifactPath = join(tmpDir, "report.md");
    const content = "# Introduction\nIntro text.\n\n# Findings\nKey findings here.\n\n# Conclusion\nDone.";
    await writeFile(artifactPath, content);

    const board = makeBoard({
      analysis: { status: "done", entries: 1, artifacts: [artifactPath] },
    });
    const injections: ContextInjection[] = [
      { from: "analysis", section: "Findings", as: "FINDINGS" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(0);
    expect(result.variables["FINDINGS"]).toContain("Key findings here.");
    expect(result.variables["FINDINGS"]).not.toContain("Intro text.");
    expect(result.variables["FINDINGS"]).not.toContain("Done.");
  });

  it("injects full content with warning when section is not found", async () => {
    const artifactPath = join(tmpDir, "report.md");
    await writeFile(artifactPath, "# Introduction\nIntro only.");

    const board = makeBoard({
      analysis: { status: "done", entries: 1, artifacts: [artifactPath] },
    });
    const injections: ContextInjection[] = [
      { from: "analysis", section: "Missing Section", as: "OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Missing Section");
    expect(result.warnings[0]).toContain("injecting full content");
    // Still injects full content
    expect(result.variables["OUTPUT"]).toContain("Intro only.");
  });

  it("produces warning when source state is not found in board", async () => {
    const board = makeBoard({});
    const injections: ContextInjection[] = [
      { from: "nonexistent-state", as: "OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("nonexistent-state");
    expect(result.warnings[0]).toContain("not found in board");
    expect(result.variables).not.toHaveProperty("OUTPUT");
  });

  it("produces warning when source state has no artifacts", async () => {
    const board = makeBoard({
      empty_state: { status: "done", entries: 1 },
    });
    const injections: ContextInjection[] = [
      { from: "empty_state", as: "OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("empty_state");
    expect(result.warnings[0]).toContain("no artifacts");
    expect(result.variables).not.toHaveProperty("OUTPUT");
  });

  it("produces warning when artifact file does not exist on disk", async () => {
    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: ["nonexistent/path.md"] },
    });
    const injections: ContextInjection[] = [
      { from: "research", as: "OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings.some(w => w.includes("nonexistent/path.md"))).toBe(true);
    expect(result.warnings.some(w => w.includes("not found on disk"))).toBe(true);
  });

  it("produces warning when all artifacts are missing, variable not set", async () => {
    const board = makeBoard({
      research: {
        status: "done",
        entries: 1,
        artifacts: ["missing1.md", "missing2.md"],
      },
    });
    const injections: ContextInjection[] = [
      { from: "research", as: "OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    // Expect warnings for each missing file plus the "all artifacts missing" warning
    expect(result.warnings.some(w => w.includes("all artifacts"))).toBe(true);
    expect(result.variables).not.toHaveProperty("OUTPUT");
  });

  it("injects partial content when some artifacts exist and others are missing", async () => {
    const existingPath = join(tmpDir, "existing.md");
    await writeFile(existingPath, "Found content.");

    const board = makeBoard({
      research: {
        status: "done",
        entries: 1,
        artifacts: [existingPath, "missing.md"],
      },
    });
    const injections: ContextInjection[] = [
      { from: "research", as: "OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    // Warning for missing file, but variable IS set with existing content
    expect(result.warnings.some(w => w.includes("missing.md"))).toBe(true);
    expect(result.variables["OUTPUT"]).toContain("Found content.");
  });

  it("concatenates multiple artifacts with double newline separator", async () => {
    const path1 = join(tmpDir, "part1.md");
    const path2 = join(tmpDir, "part2.md");
    await writeFile(path1, "First part.");
    await writeFile(path2, "Second part.");

    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: [path1, path2] },
    });
    const injections: ContextInjection[] = [
      { from: "research", as: "OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(0);
    expect(result.variables["OUTPUT"]).toContain("First part.");
    expect(result.variables["OUTPUT"]).toContain("Second part.");
  });

  it("returns hitl with prompt for from:user injection", async () => {
    const board = makeBoard({});
    const injections: ContextInjection[] = [
      { from: "user", as: "USER_INPUT", prompt: "Please provide the task scope" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.hitl).toBeDefined();
    expect(result.hitl?.prompt).toBe("Please provide the task scope");
    expect(result.hitl?.as).toBe("USER_INPUT");
    expect(result.variables).not.toHaveProperty("USER_INPUT");
  });

  it("uses default prompt text for from:user injection with no prompt field", async () => {
    const board = makeBoard({});
    const injections: ContextInjection[] = [
      { from: "user", as: "USER_INPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.hitl).toBeDefined();
    expect(result.hitl?.prompt).toBe("Please provide input");
  });

  it("handles absolute artifact paths within the workspace", async () => {
    const artifactPath = join(tmpDir, "absolute.md");
    await writeFile(artifactPath, "Absolute path content.");

    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: [artifactPath] },
    });
    const injections: ContextInjection[] = [
      { from: "research", as: "OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(0);
    expect(result.variables["OUTPUT"]).toContain("Absolute path content.");
  });

  it("blocks absolute path traversal outside workspace (e.g. /etc/passwd)", async () => {
    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: ["/etc/passwd"] },
    });
    const injections: ContextInjection[] = [
      { from: "research", as: "OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings.some(w => w.includes("/etc/passwd") && w.includes("escapes workspace"))).toBe(true);
    expect(result.variables).not.toHaveProperty("OUTPUT");
  });

  it("blocks relative path traversal that escapes workspace (e.g. ../../etc/passwd)", async () => {
    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: ["../../etc/passwd"] },
    });
    const injections: ContextInjection[] = [
      { from: "research", as: "OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings.some(w => w.includes("../../etc/passwd") && w.includes("escapes workspace"))).toBe(true);
    expect(result.variables).not.toHaveProperty("OUTPUT");
  });

  it("handles relative artifact paths by joining with workspace", async () => {
    const subdir = join(tmpDir, "artifacts");
    await mkdir(subdir);
    await writeFile(join(subdir, "relative.md"), "Relative path content.");

    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: ["artifacts/relative.md"] },
    });
    const injections: ContextInjection[] = [
      { from: "research", as: "OUTPUT" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(0);
    expect(result.variables["OUTPUT"]).toContain("Relative path content.");
  });

  it("processes multiple injections independently, collecting all warnings", async () => {
    const artifactPath = join(tmpDir, "good.md");
    await writeFile(artifactPath, "Good content.");

    const board = makeBoard({
      good_state: { status: "done", entries: 1, artifacts: [artifactPath] },
    });
    const injections: ContextInjection[] = [
      { from: "good_state", as: "GOOD" },
      { from: "missing_state", as: "MISSING" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.variables["GOOD"]).toContain("Good content.");
    expect(result.variables).not.toHaveProperty("MISSING");
    expect(result.warnings.some(w => w.includes("missing_state"))).toBe(true);
  });
});
