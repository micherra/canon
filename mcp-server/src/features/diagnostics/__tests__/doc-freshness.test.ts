/**
 * Tests for the doc-freshness service (git I/O + assembly).
 *
 * The git seam is injected so tests never spawn git. Covers:
 * - sorting by commits_since_sync descending (N>1 accumulator)
 * - docs/reference/ exclusion
 * - git-failure observability (warning surfaced, never silently dropped)
 * - missing docs/ dir → [] (no throw)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessResult } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDocFreshness } from "../services/doc-freshness.ts";

function ok(stdout: string): ProcessResult {
  return { duration_ms: 0, exitCode: 0, ok: true, stderr: "", stdout, timedOut: false };
}

function fail(stderr: string): ProcessResult {
  return { duration_ms: 0, exitCode: 1, ok: false, stderr, stdout: "", timedOut: false };
}

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "doc-freshness-"));
});

afterEach(() => {
  rmSync(projectDir, { force: true, recursive: true });
});

describe("computeDocFreshness", () => {
  it("returns [] when docs/ is missing (no throw)", () => {
    const git = () => ok("deadbeef");
    expect(computeDocFreshness(projectDir, git)).toEqual([]);
  });

  it("sorts docs by commits_since_sync descending", () => {
    mkdirSync(join(projectDir, "docs"));
    writeFileSync(join(projectDir, "docs", "a.md"), "# a");
    writeFileSync(join(projectDir, "docs", "b.md"), "# b");

    // git log → a fixed hash; rev-list --count → different counts per doc.
    const git = (args: string[]): ProcessResult => {
      if (args[0] === "log") {
        // Distinguish docs by the trailing relpath arg.
        const rel = args[args.length - 1];
        return ok(rel.endsWith("a.md") ? "hashA" : "hashB");
      }
      // rev-list --count <hash>..HEAD — hashA is 5 behind, hashB is 87 behind.
      const range = args[args.length - 1];
      return ok(range.startsWith("hashA") ? "5" : "87");
    };

    const result = computeDocFreshness(projectDir, git);
    expect(result).toHaveLength(2);
    expect(result[0].commits_since_sync).toBe(87);
    expect(result[1].commits_since_sync).toBe(5);
    expect(result[0].doc_path).toBe("docs/b.md");
    expect(result[1].doc_path).toBe("docs/a.md");
  });

  it("excludes docs/reference/ from the tracked set", () => {
    mkdirSync(join(projectDir, "docs", "reference"), { recursive: true });
    writeFileSync(join(projectDir, "docs", "top.md"), "# top");
    writeFileSync(join(projectDir, "docs", "reference", "canon-reference.md"), "# ref");

    const git = (args: string[]): ProcessResult => (args[0] === "log" ? ok("hash") : ok("3"));

    const result = computeDocFreshness(projectDir, git);
    expect(result.map((d) => d.doc_path)).toEqual(["docs/top.md"]);
    for (const doc of result) {
      expect(doc.doc_path).not.toContain("reference/");
    }
  });

  it("surfaces a warning when git log fails (observable, not dropped)", () => {
    mkdirSync(join(projectDir, "docs"));
    writeFileSync(join(projectDir, "docs", "x.md"), "# x");

    const git = (args: string[]): ProcessResult =>
      args[0] === "log" ? fail("fatal: not a git repository") : ok("0");

    const result = computeDocFreshness(projectDir, git);
    expect(result).toHaveLength(1);
    expect(result[0].warning).toBeTruthy();
    expect(result[0].warning?.length).toBeGreaterThan(0);
    // Still carries a confidence annotation (best-effort), never dropped.
    expect(result[0].confidence).toBeDefined();
  });

  it("surfaces a warning when rev-list --count fails", () => {
    mkdirSync(join(projectDir, "docs"));
    writeFileSync(join(projectDir, "docs", "x.md"), "# x");

    const git = (args: string[]): ProcessResult =>
      args[0] === "log" ? ok("hash") : fail("fatal: bad revision");

    const result = computeDocFreshness(projectDir, git);
    expect(result).toHaveLength(1);
    expect(result[0].warning).toBeTruthy();
  });

  it("treats an empty git log stdout (doc never committed) as a warning", () => {
    mkdirSync(join(projectDir, "docs"));
    writeFileSync(join(projectDir, "docs", "x.md"), "# x");

    const git = (args: string[]): ProcessResult => (args[0] === "log" ? ok("   ") : ok("0"));

    const result = computeDocFreshness(projectDir, git);
    expect(result).toHaveLength(1);
    expect(result[0].warning).toBeTruthy();
  });

  it("computes commits_since_sync and a fresh-doc high-confidence annotation", () => {
    mkdirSync(join(projectDir, "docs"));
    writeFileSync(join(projectDir, "docs", "x.md"), "# x");

    const git = (args: string[]): ProcessResult => (args[0] === "log" ? ok("hash") : ok("0"));

    const result = computeDocFreshness(projectDir, git);
    expect(result[0].commits_since_sync).toBe(0);
    expect(result[0].confidence.tier).toBe("high");
    expect(result[0].warning).toBeUndefined();
  });

  it("excludes non-markdown files in docs/", () => {
    mkdirSync(join(projectDir, "docs"));
    writeFileSync(join(projectDir, "docs", "x.md"), "# x");
    writeFileSync(join(projectDir, "docs", "diagram.png"), "binary");
    writeFileSync(join(projectDir, "docs", "notes.txt"), "text");

    const git = (args: string[]): ProcessResult => (args[0] === "log" ? ok("hash") : ok("1"));

    const result = computeDocFreshness(projectDir, git);
    expect(result.map((d) => d.doc_path)).toEqual(["docs/x.md"]);
  });
});
