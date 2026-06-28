/**
 * Glob-DoS / availability-coverage test — compiler-and-test-enforced trust boundary (C layer).
 *
 * Covers the DoS hardening for regex metacharacters in file_patterns
 * (B-layer + globToRegex).
 *
 * FILE_PATTERN_CHARSET admits ( ) { } , ! to support legitimate glob syntax.
 * The DoS guarantee must live in globToRegex (escape-all-metacharacters-then-
 * restore-globs), not the charset alone — a charset tweak is the fragile
 * enumeration posture (watch_CCCCCCCCCCCC1 / watch_UUUUUUUU2).
 *
 * These tests cover BOTH the frontmatter parser writer (parser.ts:216) AND
 * the narrow-scope override writer (matcher.ts:277). They verify:
 *   (a) loadAllPrinciples NEVER throws on admitted metacharacters
 *   (b) matching a 40-char adversarial path completes in < 50 ms (ReDoS guard)
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllPrinciples, matchPrinciples } from "@shared/matcher.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_PRINCIPLE_CONTENT } from "./overlay-sink-coverage.fixtures.ts";

// ---------------------------------------------------------------------------
// Glob-DoS hardening: regex metacharacter fixtures (B-layer + globToRegex)
// ---------------------------------------------------------------------------

describe("glob-DoS hardening: regex metacharacter fixtures (B-layer, globToRegex)", () => {
  // Patterns that pass FILE_PATTERN_CHARSET but previously caused DoS.
  // Throw-DoS patterns: unbalanced group or unknown quantifier operand.
  // ReDoS pattern: nested unbounded quantifier ((*){2,} → ([^/]*){2,} in old code).
  const DOS_PATTERNS = ["(", ")", "{", "(*){2,}"] as const;
  // 40-char slash-free adversarial segment: triggers catastrophic backtracking
  // at match time when globToRegex produces nested quantifiers.
  const ADVERSARIAL_PATH = `${"a".repeat(40)}/b.ts`;

  /** Write a project-local principle whose file_patterns contains a single test pattern. */
  async function writeProjectPrincipleWithPattern(tmpDir: string, pattern: string): Promise<void> {
    const content = [
      "---",
      "id: glob-dos-test",
      'title: "Glob DoS Test"',
      "severity: convention",
      "scope:",
      "  file_patterns:",
      `    - "${pattern}"`,
      "---",
      "Body.",
    ].join("\n");
    await mkdir(join(tmpDir, ".canon", "principles", "conventions"), { recursive: true });
    await writeFile(
      join(tmpDir, ".canon", "principles", "conventions", "glob-dos-test.md"),
      content,
    );
  }

  /** Write an override that narrows the plugin principle's file_patterns to a single test pattern. */
  async function writeOverrideWithPattern(tmpDir: string, pattern: string): Promise<void> {
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    const overrideContent = [
      "overrides:",
      "  - principle_id: trusted-principle",
      "    action: narrow-scope",
      "    reason: glob-dos regression test",
      "    applies_to:",
      "      layers: []",
      "      file_patterns:",
      `        - "${pattern}"`,
    ].join("\n");
    await writeFile(join(tmpDir, ".canon", "principle-overrides.yaml"), overrideContent);
  }

  for (const pat of DOS_PATTERNS) {
    describe(`pattern "${pat}"`, () => {
      let tmp: string;
      let plugin: string;

      beforeEach(async () => {
        tmp = await mkdtemp(join(tmpdir(), "canon-glob-dos-"));
        plugin = join(tmp, "plugin");
        // Plugin principle needed so override tests have a target principle
        await mkdir(join(plugin, "principles", "conventions"), { recursive: true });
        await writeFile(
          join(plugin, "principles", "conventions", "trusted-principle.md"),
          PLUGIN_PRINCIPLE_CONTENT,
        );
      });

      afterEach(async () => {
        await rm(tmp, { force: true, recursive: true });
      });

      it("frontmatter path: loadAllPrinciples does not throw", async () => {
        await writeProjectPrincipleWithPattern(tmp, pat);
        await expect(loadAllPrinciples(tmp, plugin)).resolves.toBeDefined();
      });

      it("override path: loadAllPrinciples does not throw", async () => {
        // Override targets the plugin principle — no project principle needed
        await writeOverrideWithPattern(tmp, pat);
        await expect(loadAllPrinciples(tmp, plugin)).resolves.toBeDefined();
      });

      it("frontmatter path: matching adversarial path completes in < 50 ms", async () => {
        await writeProjectPrincipleWithPattern(tmp, pat);
        const principles = await loadAllPrinciples(tmp, plugin);
        const start = Date.now();
        matchPrinciples(principles, { file_path: ADVERSARIAL_PATH });
        const elapsed = Date.now() - start;
        expect(
          elapsed,
          `ReDoS guard: match took ${elapsed}ms — must complete in < 50ms`,
        ).toBeLessThan(50);
      });

      it("override path: matching adversarial path completes in < 50 ms", async () => {
        await writeOverrideWithPattern(tmp, pat);
        const principles = await loadAllPrinciples(tmp, plugin);
        const start = Date.now();
        matchPrinciples(principles, { file_path: ADVERSARIAL_PATH });
        const elapsed = Date.now() - start;
        expect(
          elapsed,
          `ReDoS guard: match took ${elapsed}ms — must complete in < 50ms`,
        ).toBeLessThan(50);
      });
    });
  }
});
