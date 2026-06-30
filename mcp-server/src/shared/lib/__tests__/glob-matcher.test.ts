/**
 * Unit tests for matchGlob (linear-time glob matcher).
 *
 * Covers:
 *   (a) Parity with old `globToRegex` + RegExp behavior — the oracle kept here as a
 *       reference implementation to assert byte-identical boolean outputs across a
 *       large pattern×path matrix (all shipped principle file_patterns + common paths).
 *   (b) Sequential-wildcard ReDoS timing guard — the attack that `globToRegex` left open:
 *       `"a*".repeat(8)+"b"` and `("**a").repeat(6)+"b"` must complete in < 50 ms
 *       against a 50-char adversarial path (old code took 7.4 s at n=50).
 *   (c) Unit behavior tests — basic glob semantics, edge cases, `**` vs `*` semantics.
 */

import { describe, expect, it } from "vitest";
import { matchGlob } from "../glob-matcher.ts";

// ---------------------------------------------------------------------------
// Oracle: old globToRegex implementation (kept for parity verification only).
// This is the exact function that was replaced. It produces a RegExp with
// unbounded quantifiers — which is WHY it was replaced — but it gives us a
// ground truth for the boolean output that the new matchGlob must replicate.
// ---------------------------------------------------------------------------

/** Old implementation preserved as oracle. Do NOT use outside this test file. */
function oldGlobToRegex(pattern: string): RegExp {
  const regex = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // escape all metacharacters
    .replace(/\\\*\\\*/g, ".*") // \*\* → .* (any path segment, incl. /)
    .replace(/\\\*/g, "[^/]*"); // \*  → [^/]* (one path segment, no /)
  return new RegExp(`(^|/)${regex}$`);
}

function oldMatchGlob(pattern: string, path: string): boolean {
  return oldGlobToRegex(pattern).test(path);
}

// ---------------------------------------------------------------------------
// Parity test matrix
// Patterns: all shipped principle file_patterns + common glob patterns.
// Paths:    representative file paths used across the Canon codebase.
// ---------------------------------------------------------------------------

const PARITY_PATTERNS = [
  // Shipped principle file_patterns (from .canon/principles + principles/)
  "**/.github/**",
  "**/CLAUDE.md",
  "**/hooks/**",
  "**/mcp-server/src/**",
  "**/package.json",
  "**/plans/**/DESIGN.md",
  "**/plans/**/PROBE-FINDINGS.md",
  "**/templates/**",
  ".claude-plugin/*",
  ".github/**",
  "CLAUDE.md",
  "agents/**",
  "agents/*.md",
  "boot.sh",
  "docs/adr/**",
  "hooks/**",
  "loops/**",
  "mcp-server/**",
  "mcp-server/boot.sh",
  "mcp-server/src/**",
  "mcp-server/src/**/*.ts",
  "mcp-server/src/app/**",
  "mcp-server/src/app/register-*.ts",
  "mcp-server/src/features/**/ensure-*.ts",
  "mcp-server/src/features/**/services/*.ts",
  "mcp-server/src/features/**/tools/*.ts",
  "mcp-server/src/features/*/services/**",
  "mcp-server/src/features/diagnostics/services/**",
  "mcp-server/src/features/diagnostics/tools/**",
  "mcp-server/src/features/knowledge-graph/**",
  "mcp-server/src/features/orchestration/**",
  "mcp-server/src/features/orchestration/tools/**",
  "mcp-server/src/features/pr-review/**",
  "mcp-server/src/platform/storage/**",
  "mcp-server/src/shared/lib/atomic-write.ts",
  "mcp-server/src/ui/snippets/**",
  "mcp-server/src/ui/snippets/*.html",
  "plans/**/DESIGN.md",
  "plans/**/PROBE-FINDINGS.md",
  "principles/**",
  "**/*.css",
  "**/*.module.css",
  "**/*.scss",
  "**/*.spec.*",
  "**/*.test.*",
  "**/*.tf",
  "**/*.tfvars",
  "**/*.tsx",
  "**/*.vue",
  "**/.github/workflows/**",
  "**/__tests__/**",
  "**/features/**",
  "**/migrate/**",
  "**/migrations/**",
  "**/package-lock.json",
  "**/schema*",
  "**/terraform/**",
  "**/test/**",
  "**/tests/**",
  ".canon/principles/**/*.md",
  "apps/**",
  "packages/**",
  "principles/**/*.md",
  "mcp-server/src/features/loops/load-loops.ts",
  "mcp-server/src/shared/matcher.ts",
  "mcp-server/src/shared/routine.ts",
  // Common additional patterns
  "*.md",
  "*.ts",
  "*.sh",
  "foo/*",
  "src/**",
  "src/**/*.ts",
  "**/*.ts",
  "**/*.test.ts",
  "**/foo.ts",
  "src/**/services/*.ts",
  "a/b/c.ts",
];

const PARITY_PATHS = [
  // Relative file paths representative of the Canon codebase
  "CLAUDE.md",
  "README.md",
  "boot.sh",
  "src/a.ts",
  "src/routes/users.ts",
  "src/components/Button.tsx",
  "infra/main.tf",
  "infra/terraform/main.tf",
  "foo.ts",
  "a/b/c.ts",
  "agents/engineer.md",
  "agents/reviewer.md",
  "hooks/pre-commit.sh",
  "hooks/lib/canon-hook-lib.sh",
  ".github/workflows/ci.yml",
  "plans/my-slug/DESIGN.md",
  "plans/my-slug/PROBE-FINDINGS.md",
  "mcp-server/src/app/index.ts",
  "mcp-server/src/app/register-knowledge.ts",
  "mcp-server/src/shared/matcher.ts",
  "mcp-server/src/shared/lib/atomic-write.ts",
  "mcp-server/src/features/pr-review/tools/store.ts",
  "mcp-server/src/features/pr-review/services/pr-service.ts",
  "mcp-server/src/features/orchestration/tools/init-workspace.ts",
  "mcp-server/src/features/orchestration/services/workspace.ts",
  "mcp-server/src/features/diagnostics/tools/drift.ts",
  "mcp-server/src/features/diagnostics/services/wiki-lint.ts",
  "mcp-server/src/features/knowledge-graph/ensure-graph-fresh.ts",
  "mcp-server/src/platform/storage/drift/drift-db.ts",
  "mcp-server/src/ui/snippets/review.html",
  "mcp-server/src/ui/snippets/design.html",
  "mcp-server/src/features/loops/load-loops.ts",
  ".canon/principles/conventions/foo.md",
  ".canon/principles/rules/no-llm-calls.md",
  ".github/workflows/release-please.yml",
  "src/style.css",
  "src/app/page.tsx",
  "src/services/__tests__/foo.test.ts",
  "docs/adr/0001-foo.md",
  "packages/core/index.ts",
  "",
];

describe("matchGlob parity with old globToRegex behavior", () => {
  it(`returns identical boolean for all ${PARITY_PATTERNS.length * PARITY_PATHS.length} pattern×path pairs`, () => {
    const mismatches: Array<{ pattern: string; path: string; new: boolean; old: boolean }> = [];
    for (const pattern of PARITY_PATTERNS) {
      for (const path of PARITY_PATHS) {
        const newResult = matchGlob(pattern, path);
        const oldResult = oldMatchGlob(pattern, path);
        if (newResult !== oldResult) {
          mismatches.push({ pattern, path, new: newResult, old: oldResult });
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sequential-wildcard ReDoS timing guard
// ---------------------------------------------------------------------------

/** 50-char slash-free adversarial segment: the key case for sequential-wildcard ReDoS. */
const ADVERSARIAL_PATH_50 = `${"a".repeat(50)}/b.ts`;

describe("matchGlob sequential-wildcard ReDoS timing", () => {
  it("a*-repeat(8)+b against 50-char slash-free path completes in < 50 ms", () => {
    const pattern = `${"a*".repeat(8)}b`;
    const start = Date.now();
    matchGlob(pattern, ADVERSARIAL_PATH_50);
    const elapsed = Date.now() - start;
    expect(elapsed, `sequential-wildcard: took ${elapsed}ms, must be < 50ms`).toBeLessThan(50);
  });

  it("(**a)-repeat(6)+b against 50-char slash-free path completes in < 50 ms", () => {
    const pattern = `${"**a".repeat(6)}b`;
    const start = Date.now();
    matchGlob(pattern, ADVERSARIAL_PATH_50);
    const elapsed = Date.now() - start;
    expect(elapsed, `sequential-double-star: took ${elapsed}ms, must be < 50ms`).toBeLessThan(50);
  });

  it("a*-repeat(12)+b against 50-char path completes in < 50 ms (12 stars)", () => {
    // Old code: > 120s on this pattern (probe timeout). New code: O(n*m) always.
    const pattern = `${"a*".repeat(12)}b`;
    const start = Date.now();
    matchGlob(pattern, ADVERSARIAL_PATH_50);
    const elapsed = Date.now() - start;
    expect(elapsed, `12-star pattern: took ${elapsed}ms, must be < 50ms`).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// Unit behavior tests
// ---------------------------------------------------------------------------

describe("matchGlob unit behavior", () => {
  describe("literal matching", () => {
    it("matches exact path from start", () => {
      expect(matchGlob("a/b/c.ts", "a/b/c.ts")).toBe(true);
    });

    it("matches exact path as suffix after segment boundary", () => {
      expect(matchGlob("a/b/c.ts", "x/a/b/c.ts")).toBe(true);
    });

    it("does not match non-matching literal", () => {
      expect(matchGlob("a/b/c.ts", "a/b/c.js")).toBe(false);
    });

    it("matches at segment boundary after long prefix", () => {
      expect(matchGlob("foo.ts", "src/a/b/foo.ts")).toBe(true);
    });
  });

  describe("single-star wildcard (*)", () => {
    it("* matches any chars except /", () => {
      expect(matchGlob("*.ts", "foo.ts")).toBe(true);
    });

    it("* does not cross /", () => {
      // From start: * can't consume 'src' then '/'. From after '/': only the segment after.
      // Matches from the position after the last '/' in 'src/foo.ts'
      expect(matchGlob("*.ts", "src/foo.ts")).toBe(true);
    });

    it("* matches zero chars", () => {
      expect(matchGlob("*.ts", ".ts")).toBe(true);
    });

    it("* matches multiple chars in a segment", () => {
      expect(matchGlob("foo*bar.ts", "fooXXXbar.ts")).toBe(true);
    });

    it("* does not match across / in the middle of a segment span", () => {
      // Pattern foo*bar.ts, path foo/bar.ts: * would need to match '/' → false
      expect(matchGlob("foo*bar.ts", "foo/bar.ts")).toBe(false);
    });

    it("agents/*.md matches agents/engineer.md", () => {
      expect(matchGlob("agents/*.md", "agents/engineer.md")).toBe(true);
    });

    it("agents/*.md does not match agents/sub/engineer.md", () => {
      expect(matchGlob("agents/*.md", "agents/sub/engineer.md")).toBe(false);
    });
  });

  describe("double-star wildcard (**)", () => {
    it("** matches any chars including /", () => {
      expect(matchGlob("**/*.ts", "src/a/b/c.ts")).toBe(true);
    });

    it("** matches zero chars (adjacent to literal)", () => {
      // **/*.ts should match src/a.ts where ** matches 'src' (no trailing /)
      // Old code: (^|/).*\/[^/]*\.ts$ against src/a.ts → true (from ^: .* = src, / = /, a.ts)
      expect(matchGlob("**/*.ts", "src/a.ts")).toBe(true);
    });

    it("src/**/*.ts does NOT match src/a.ts (pre-existing behavior)", () => {
      // Confirmed in SECURITY-REREVIEW-4: both old and new are false for this case.
      expect(matchGlob("src/**/*.ts", "src/a.ts")).toBe(false);
    });

    it("src/**/*.ts matches src/x/a.ts", () => {
      expect(matchGlob("src/**/*.ts", "src/x/a.ts")).toBe(true);
    });

    it("src/**/*.ts matches src/x/y/z/a.ts", () => {
      expect(matchGlob("src/**/*.ts", "src/x/y/z/a.ts")).toBe(true);
    });

    it("** at end matches any path extension", () => {
      expect(matchGlob("src/**", "src/a/b/c.ts")).toBe(true);
    });

    it("** at end matches single-level file", () => {
      expect(matchGlob("src/**", "src/foo.ts")).toBe(true);
    });

    it("agents/** matches agents/engineer.md", () => {
      expect(matchGlob("agents/**", "agents/engineer.md")).toBe(true);
    });

    it("mcp-server/src/**/*.ts matches deeply nested ts file", () => {
      expect(
        matchGlob(
          "mcp-server/src/**/*.ts",
          "mcp-server/src/features/orchestration/tools/init-workspace.ts",
        ),
      ).toBe(true);
    });

    it("plans/**/DESIGN.md matches plans/my-slug/DESIGN.md", () => {
      expect(matchGlob("plans/**/DESIGN.md", "plans/my-slug/DESIGN.md")).toBe(true);
    });

    it("**/plans/**/DESIGN.md matches nested plan path", () => {
      expect(
        matchGlob("**/plans/**/DESIGN.md", ".canon/workspaces/some-slug/plans/task/DESIGN.md"),
      ).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("empty pattern does not match non-empty path", () => {
      expect(matchGlob("", "foo.ts")).toBe(false);
    });

    it("empty pattern matches empty string", () => {
      expect(matchGlob("", "")).toBe(true);
    });

    it("** alone matches any path", () => {
      expect(matchGlob("**", "src/a/b/c.ts")).toBe(true);
    });

    it("** matches empty path", () => {
      expect(matchGlob("**", "")).toBe(true);
    });

    it("* matches empty path", () => {
      expect(matchGlob("*", "")).toBe(true);
    });

    it("exact filename match with dot extension", () => {
      expect(matchGlob("foo.ts", "foo.ts")).toBe(true);
    });

    it("does not partially match at end of pattern", () => {
      expect(matchGlob("foo.ts", "fooXts")).toBe(false);
    });

    it("trailing * matches zero chars in last segment", () => {
      expect(matchGlob("a*", "a")).toBe(true);
    });
  });
});
