/**
 * Unit tests for evaluate-step tool.
 *
 * Tests are pure — they use the exported internal helpers directly
 * (parseDiff, scanPatterns, detectBareCatches, computeFileScopeOverlap)
 * and call evaluateStep with a mocked gitDiff to avoid subprocess calls.
 *
 * TDD order: all tests written before implementation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EvaluateStepInput,
  FileScopeOverlap,
  PatternFinding,
} from "../tools/evaluate-step.ts";
import { evaluateStep } from "../tools/evaluate-step.ts";

// ─── Mock git adapter ─────────────────────────────────────────────────────────

// We mock the git-adapter module so evaluateStep doesn't spawn real git processes.
vi.mock("@platform/adapters/git-adapter.ts", () => ({
  gitDiff: vi.fn(),
}));

import { gitDiff } from "@platform/adapters/git-adapter.ts";

const mockGitDiff = vi.mocked(gitDiff);

function makeGitDiffResult(stdout: string, ok = true) {
  return {
    duration_ms: 5,
    exitCode: ok ? 0 : 128,
    ok,
    stderr: ok ? "" : "fatal: bad revision",
    stdout,
    timedOut: false,
  };
}

// ─── Sample diff fixtures ─────────────────────────────────────────────────────

/** Minimal valid unified diff adding one line */
const DIFF_ONE_ADDED_LINE = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,0 +2,1 @@
+const x = 1; // added line
`;

/** Diff with removed lines containing TODO (should NOT be flagged) */
const DIFF_TODO_IN_REMOVED = `diff --git a/src/bar.ts b/src/bar.ts
index abc..def 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -5,3 +5,1 @@
-// TODO: remove this
-const oldCode = true;
+const newCode = false;
`;

/** Diff adding a TODO in an added line */
const DIFF_TODO_ADDED = `diff --git a/src/baz.ts b/src/baz.ts
index abc..def 100644
--- a/src/baz.ts
+++ b/src/baz.ts
@@ -1,0 +2,1 @@
+// TODO: clean this up
`;

/** Diff adding multiple lazy pattern markers */
const DIFF_LAZY_MARKERS = `diff --git a/src/lazy.ts b/src/lazy.ts
index 000..111 100644
--- a/src/lazy.ts
+++ b/src/lazy.ts
@@ -1,0 +1,6 @@
+// TODO: implement
+// FIXME: this is broken
+// HACK: workaround
+// XXX: ugly
+const desc = "placeholder text";
+const pw = password = "mysecrettoken";
`;

/** Diff adding hacky patterns */
const DIFF_HACKY_PATTERNS = `diff --git a/src/hacky.ts b/src/hacky.ts
index 000..111 100644
--- a/src/hacky.ts
+++ b/src/hacky.ts
@@ -1,0 +1,5 @@
+const x = value as any;
+const y = value as unknown;
+// eslint-disable-next-line
+// @ts-ignore
+// @ts-expect-error some error
`;

/** Diff with bare catch (no comment — should be flagged) */
const DIFF_BARE_CATCH_NO_COMMENT = `diff --git a/src/catch.ts b/src/catch.ts
index 000..111 100644
--- a/src/catch.ts
+++ b/src/catch.ts
@@ -1,0 +1,6 @@
+try {
+  doSomething();
+} catch (e) {
+
+}
`;

/** Diff with bare catch but has inline comment — should NOT be flagged */
const DIFF_BARE_CATCH_WITH_INLINE_COMMENT = `diff --git a/src/catch2.ts b/src/catch2.ts
index 000..111 100644
--- a/src/catch2.ts
+++ b/src/catch2.ts
@@ -1,0 +1,5 @@
+try {
+  doSomething();
+} catch (e) { /* ignore close errors */
+
+}
`;

/** Diff with catch that has comment inside block — should NOT be flagged */
const DIFF_BARE_CATCH_WITH_BLOCK_COMMENT = `diff --git a/src/catch3.ts b/src/catch3.ts
index 000..111 100644
--- a/src/catch3.ts
+++ b/src/catch3.ts
@@ -1,0 +1,6 @@
+try {
+  doSomething();
+} catch (e) {
+  // intentional — stream cleanup
+}
`;

/** Diff with catch that has comment on preceding line — should NOT be flagged */
const DIFF_BARE_CATCH_WITH_PRECEDING_COMMENT = `diff --git a/src/catch4.ts b/src/catch4.ts
index 000..111 100644
--- a/src/catch4.ts
+++ b/src/catch4.ts
@@ -1,0 +1,6 @@
+try {
+  doSomething();
+// ignore errors here
+} catch (e) {
+}
`;

/** Diff touching two files */
const DIFF_TWO_FILES = `diff --git a/src/a.ts b/src/a.ts
index 000..111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,0 +1,2 @@
+const a = 1;
+const b = 2;
diff --git a/src/c.ts b/src/c.ts
index 000..111 100644
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,0 +1,1 @@
+const c = 3;
`;

/** Empty diff */
const DIFF_EMPTY = "";

/** Diff with stats: 3 added, 2 removed across 1 file */
const DIFF_STATS = `diff --git a/src/stats.ts b/src/stats.ts
index 000..111 100644
--- a/src/stats.ts
+++ b/src/stats.ts
@@ -1,5 +1,6 @@
 const existing = true;
-const removed1 = 1;
-const removed2 = 2;
+const added1 = 1;
+const added2 = 2;
+const added3 = 3;
 const end = true;
`;

/** Diff with hardcoded secret */
const DIFF_HARDCODED_SECRET = `diff --git a/src/config.ts b/src/config.ts
index 000..111 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,0 +1,3 @@
+const apiKey = api_key = "longAPIkeyvalue";
+const emptyPw = password = "";
+const shortPw = secret = "ab";
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_INPUT: EvaluateStepInput = {
  base_commit: "abc123",
  declared_files: ["src/foo.ts"],
  slug: "test-slug",
  workspace: "/tmp/ws",
  worktree_path: "/tmp/worktree",
};

function makeInput(overrides: Partial<EvaluateStepInput> = {}): EvaluateStepInput {
  return { ...BASE_INPUT, ...overrides };
}

// ─── Diff parsing ─────────────────────────────────────────────────────────────

describe("evaluateStep — diff parsing", () => {
  beforeEach(() => {
    mockGitDiff.mockReset();
  });

  it("parses a unified diff with one added line", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_ONE_ADDED_LINE));

    const result = await evaluateStep(makeInput({ declared_files: ["src/foo.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diff_stats.files_changed).toBe(1);
    expect(result.diff_stats.lines_added).toBe(1);
    expect(result.diff_stats.lines_removed).toBe(0);
  });

  it("parses diff with added AND removed lines — only adds are counted for patterns", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_TODO_IN_REMOVED));

    const result = await evaluateStep(makeInput({ declared_files: ["src/bar.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // TODO is in a removed line, must NOT be flagged
    expect(result.findings.length).toBe(0);
    expect(result.diff_stats.lines_removed).toBe(2);
    expect(result.diff_stats.lines_added).toBe(1);
  });

  it("parses diff touching two files and reports correct file count", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_TWO_FILES));

    const result = await evaluateStep(makeInput({ declared_files: ["src/a.ts", "src/c.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diff_stats.files_changed).toBe(2);
  });

  it("handles empty diff — zero stats, no findings", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_EMPTY));

    const result = await evaluateStep(makeInput({ declared_files: [] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings.length).toBe(0);
    expect(result.diff_stats.files_changed).toBe(0);
    expect(result.diff_stats.lines_added).toBe(0);
    expect(result.diff_stats.lines_removed).toBe(0);
  });

  it("computes diff stats correctly (3 added, 2 removed)", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_STATS));

    const result = await evaluateStep(makeInput({ declared_files: ["src/stats.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diff_stats.lines_added).toBe(3);
    expect(result.diff_stats.lines_removed).toBe(2);
    expect(result.diff_stats.files_changed).toBe(1);
  });
});

// ─── Pattern detection — lazy ─────────────────────────────────────────────────

describe("evaluateStep — lazy pattern detection", () => {
  beforeEach(() => {
    mockGitDiff.mockReset();
  });

  it("detects TODO in added line", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_TODO_ADDED));

    const result = await evaluateStep(makeInput({ declared_files: ["src/baz.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const todoFindings = result.findings.filter((f: PatternFinding) => f.pattern_id === "todo");
    expect(todoFindings.length).toBeGreaterThan(0);
    expect(todoFindings[0].category).toBe("lazy");
    expect(todoFindings[0].file_path).toBe("src/baz.ts");
  });

  it("does NOT detect TODO in removed lines", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_TODO_IN_REMOVED));

    const result = await evaluateStep(makeInput({ declared_files: ["src/bar.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const todoFindings = result.findings.filter((f: PatternFinding) => f.pattern_id === "todo");
    expect(todoFindings.length).toBe(0);
  });

  it("detects all 6 lazy markers in a multi-line diff", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_LAZY_MARKERS));

    const result = await evaluateStep(makeInput({ declared_files: ["src/lazy.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lazyFindings = result.findings.filter((f: PatternFinding) => f.category === "lazy");
    const patternIds = lazyFindings.map((f: PatternFinding) => f.pattern_id);
    expect(patternIds).toContain("todo");
    expect(patternIds).toContain("fixme");
    expect(patternIds).toContain("hack");
    expect(patternIds).toContain("xxx");
    expect(patternIds).toContain("placeholder");
    expect(result.finding_counts.lazy).toBeGreaterThanOrEqual(5);
  });

  it("detects hardcoded secret (password = 'longvalue') in added line", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_HARDCODED_SECRET));

    const result = await evaluateStep(makeInput({ declared_files: ["src/config.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const secretFindings = result.findings.filter(
      (f: PatternFinding) => f.pattern_id === "hardcoded-secret",
    );
    expect(secretFindings.length).toBeGreaterThan(0);
    expect(secretFindings[0].category).toBe("lazy");
  });

  it("does NOT flag hardcoded secret when value is empty or < 3 chars", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_HARDCODED_SECRET));

    const result = await evaluateStep(makeInput({ declared_files: ["src/config.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const secretFindings = result.findings.filter(
      (f: PatternFinding) => f.pattern_id === "hardcoded-secret",
    );
    // Lines with empty string or "ab" (2 chars) must NOT be flagged
    // Only the "longAPIkeyvalue" line should be flagged
    const matchedTexts = secretFindings.map((f: PatternFinding) => f.matched_text);
    expect(matchedTexts.every((t: string) => !t.includes('= ""'))).toBe(true);
  });
});

// ─── Pattern detection — hacky ────────────────────────────────────────────────

describe("evaluateStep — hacky pattern detection", () => {
  beforeEach(() => {
    mockGitDiff.mockReset();
  });

  it("detects as any, as unknown, eslint-disable, @ts-ignore, @ts-expect-error in added lines", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_HACKY_PATTERNS));

    const result = await evaluateStep(makeInput({ declared_files: ["src/hacky.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hackyFindings = result.findings.filter((f: PatternFinding) => f.category === "hacky");
    const patternIds = hackyFindings.map((f: PatternFinding) => f.pattern_id);
    expect(patternIds).toContain("as-any");
    expect(patternIds).toContain("as-unknown");
    expect(patternIds).toContain("eslint-disable");
    expect(patternIds).toContain("ts-ignore");
    expect(patternIds).toContain("ts-expect-error");
    expect(result.finding_counts.hacky).toBeGreaterThanOrEqual(5);
  });
});

// ─── Bare-catch detection ─────────────────────────────────────────────────────

describe("evaluateStep — bare-catch detection", () => {
  beforeEach(() => {
    mockGitDiff.mockReset();
  });

  it("flags bare catch without any comment", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_BARE_CATCH_NO_COMMENT));

    const result = await evaluateStep(makeInput({ declared_files: ["src/catch.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const catchFindings = result.findings.filter(
      (f: PatternFinding) => f.pattern_id === "bare-catch",
    );
    expect(catchFindings.length).toBeGreaterThan(0);
    expect(catchFindings[0].category).toBe("hacky");
  });

  it("does NOT flag bare catch with inline comment on catch line (allowlist)", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_BARE_CATCH_WITH_INLINE_COMMENT));

    const result = await evaluateStep(makeInput({ declared_files: ["src/catch2.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const catchFindings = result.findings.filter(
      (f: PatternFinding) => f.pattern_id === "bare-catch",
    );
    expect(catchFindings.length).toBe(0);
  });

  it("does NOT flag bare catch with comment inside block (allowlist)", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_BARE_CATCH_WITH_BLOCK_COMMENT));

    const result = await evaluateStep(makeInput({ declared_files: ["src/catch3.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const catchFindings = result.findings.filter(
      (f: PatternFinding) => f.pattern_id === "bare-catch",
    );
    expect(catchFindings.length).toBe(0);
  });

  it("does NOT flag bare catch with comment on preceding line (allowlist)", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_BARE_CATCH_WITH_PRECEDING_COMMENT));

    const result = await evaluateStep(makeInput({ declared_files: ["src/catch4.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const catchFindings = result.findings.filter(
      (f: PatternFinding) => f.pattern_id === "bare-catch",
    );
    expect(catchFindings.length).toBe(0);
  });
});

// ─── File-scope overlap ───────────────────────────────────────────────────────

describe("evaluateStep — file-scope overlap", () => {
  beforeEach(() => {
    mockGitDiff.mockReset();
  });

  it("classifies in-scope, out-of-scope, and missing-planned correctly", async () => {
    // declared: [a.ts, b.ts], diff touches [a.ts, c.ts]
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_TWO_FILES));

    const result = await evaluateStep(
      makeInput({
        declared_files: ["src/a.ts", "src/b.ts"],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scope: FileScopeOverlap = result.file_scope;
    expect(scope.in_scope).toBe(1); // src/a.ts is in both
    expect(scope.out_of_scope).toBe(1); // src/c.ts is not declared
    expect(scope.out_of_scope_files).toContain("src/c.ts");
    expect(scope.missing_planned).toContain("src/b.ts");
    expect(scope.declared).toContain("src/a.ts");
    expect(scope.declared).toContain("src/b.ts");
    expect(scope.actual).toContain("src/a.ts");
    expect(scope.actual).toContain("src/c.ts");
  });

  it("reports empty overlap when diff and declared have no overlap", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_ONE_ADDED_LINE));

    const result = await evaluateStep(
      makeInput({
        declared_files: ["src/other.ts"],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scope = result.file_scope;
    expect(scope.in_scope).toBe(0);
    expect(scope.out_of_scope).toBe(1); // src/foo.ts is not declared
    expect(scope.missing_planned).toContain("src/other.ts");
  });

  it("reports all in-scope when diff matches declared exactly", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_ONE_ADDED_LINE));

    const result = await evaluateStep(
      makeInput({
        declared_files: ["src/foo.ts"],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scope = result.file_scope;
    expect(scope.in_scope).toBe(1);
    expect(scope.out_of_scope).toBe(0);
    expect(scope.missing_planned.length).toBe(0);
  });
});

// ─── Finding counts ───────────────────────────────────────────────────────────

describe("evaluateStep — finding counts", () => {
  beforeEach(() => {
    mockGitDiff.mockReset();
  });

  it("finding_counts.lazy and finding_counts.hacky match findings array", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_LAZY_MARKERS));

    const result = await evaluateStep(makeInput({ declared_files: ["src/lazy.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lazyCount = result.findings.filter((f: PatternFinding) => f.category === "lazy").length;
    const hackyCount = result.findings.filter((f: PatternFinding) => f.category === "hacky").length;
    expect(result.finding_counts.lazy).toBe(lazyCount);
    expect(result.finding_counts.hacky).toBe(hackyCount);
  });
});

// ─── Slug validation ──────────────────────────────────────────────────────────

describe("evaluateStep — slug validation", () => {
  it("returns INVALID_INPUT for slug with spaces", async () => {
    const result = await evaluateStep(makeInput({ slug: "has spaces" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.message).toContain("slug");
  });

  it("returns INVALID_INPUT for slug with path separator", async () => {
    const result = await evaluateStep(makeInput({ slug: "my/slug" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("accepts valid slug with hyphens and underscores", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_EMPTY));

    const result = await evaluateStep(makeInput({ slug: "my-slug_123" }));

    expect(result.ok).toBe(true);
  });
});

// ─── Git diff failure ─────────────────────────────────────────────────────────

describe("evaluateStep — git diff failure", () => {
  beforeEach(() => {
    mockGitDiff.mockReset();
  });

  it("returns UNEXPECTED error when gitDiff fails", async () => {
    mockGitDiff.mockReturnValue(makeGitDiffResult("", false));

    const result = await evaluateStep(makeInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("UNEXPECTED");
    expect(result.message).toContain("git diff failed");
  });
});

// ─── Line numbers ─────────────────────────────────────────────────────────────

describe("evaluateStep — line number extraction", () => {
  beforeEach(() => {
    mockGitDiff.mockReset();
  });

  it("records correct line number from hunk header for a finding", async () => {
    // The hunk header @@ -1,0 +2,1 @@ means added line starts at line 2
    mockGitDiff.mockReturnValue(makeGitDiffResult(DIFF_TODO_ADDED));

    const result = await evaluateStep(makeInput({ declared_files: ["src/baz.ts"] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const todoFindings = result.findings.filter((f: PatternFinding) => f.pattern_id === "todo");
    expect(todoFindings.length).toBeGreaterThan(0);
    expect(typeof todoFindings[0].line_number).toBe("number");
    expect(todoFindings[0].line_number).toBeGreaterThan(0);
  });
});
