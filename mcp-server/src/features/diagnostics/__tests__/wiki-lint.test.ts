/**
 * Tests for the Wiki-Lint service.
 *
 * Each test exercises a single behavior of one check function.
 * All inputs are in-memory; no disk I/O except where noted.
 *
 * Test plan:
 *
 * checkContradictions:
 * - two files with "must use X" and "never use X" -> 1 finding
 * - same file with contradictory statements -> 0 findings (only cross-file)
 * - no contradictions -> empty array
 * - different entities with same verb -> no false positive
 *
 * checkOrphanPrinciples:
 * - principle with violations -> not orphan
 * - principle with references -> not orphan
 * - principle with neither -> orphan
 * - empty inputs -> empty array
 *
 * checkStaleRefs:
 * - backtick path that exists -> no finding
 * - backtick path that doesn't exist -> finding with correct line number
 * - URL is skipped -> no finding
 * - path with no directory component skipped
 *
 * checkMissingExamples:
 * - principle with Examples section -> no finding
 * - principle without Examples section -> finding
 * - principle with empty Examples section -> finding
 *
 * assembleWikiLintOutput:
 * - assembles all arrays and computes summary counts
 */

import type { Principle } from "@shared/parser.ts";
import { describe, expect, it } from "vitest";
import {
  assembleWikiLintOutput,
  checkContradictions,
  checkMissingExamples,
  checkOrphanPrinciples,
  checkStaleRefs,
} from "../services/wiki-lint.ts";

// ---- Helpers ----

function makePrinciple(overrides: Partial<Principle> = {}): Principle {
  return {
    id: "test-principle",
    title: "Test Principle",
    severity: "convention",
    scope: { layers: [], file_patterns: [] },
    tags: [],
    archived: false,
    body: "Some body text.",
    filePath: "principles/conventions/test-principle.md",
    ...overrides,
  };
}

// ---- checkContradictions ----

describe("checkContradictions", () => {
  it("detects cross-file must/never conflict on the same entity", () => {
    const files = [
      { path: "foo/CLAUDE.md", content: "You must use worktrees for isolation." },
      { path: "bar/CLAUDE.md", content: "Never use worktrees in this context." },
    ];
    const findings = checkContradictions(files);
    expect(findings.length).toBe(1);
    expect(findings[0].entity).toMatch(/worktree/i);
    expect(findings[0].file_a).toBe("foo/CLAUDE.md");
    expect(findings[0].file_b).toBe("bar/CLAUDE.md");
  });

  it("ignores contradictions within the same file", () => {
    const files = [
      {
        path: "foo/CLAUDE.md",
        content: "You must use worktrees.\nNever use worktrees.",
      },
    ];
    const findings = checkContradictions(files);
    expect(findings).toHaveLength(0);
  });

  it("returns empty array when no contradictions exist", () => {
    const files = [
      { path: "a/CLAUDE.md", content: "Must use TypeScript." },
      { path: "b/CLAUDE.md", content: "Must use TypeScript." },
    ];
    const findings = checkContradictions(files);
    expect(findings).toHaveLength(0);
  });

  it("does not flag different entities that share the same verb", () => {
    const files = [
      { path: "a/CLAUDE.md", content: "Must use TypeScript." },
      { path: "b/CLAUDE.md", content: "Never use JavaScript." },
    ];
    const findings = checkContradictions(files);
    expect(findings).toHaveLength(0);
  });

  it("does not report contradiction when two files share the same must-not prohibition", () => {
    const files = [
      { path: "a/CLAUDE.md", content: "Agents must not mutate state directly." },
      { path: "b/CLAUDE.md", content: "Agents must not mutate state directly." },
    ];
    const result = checkContradictions(files);
    expect(result).toHaveLength(0);
  });
});

// ---- checkOrphanPrinciples ----

describe("checkOrphanPrinciples", () => {
  it("does not flag a principle that appears in violatedIds", () => {
    const principles = [makePrinciple({ id: "foo" })];
    const violated = new Set(["foo"]);
    const referenced = new Set<string>();
    const findings = checkOrphanPrinciples(principles, violated, referenced);
    expect(findings).toHaveLength(0);
  });

  it("does not flag a principle that appears in referencedIds", () => {
    const principles = [makePrinciple({ id: "bar" })];
    const violated = new Set<string>();
    const referenced = new Set(["bar"]);
    const findings = checkOrphanPrinciples(principles, violated, referenced);
    expect(findings).toHaveLength(0);
  });

  it("flags a principle with no violations and no references", () => {
    const principles = [
      makePrinciple({
        id: "orphan",
        severity: "strong-opinion",
        filePath: "principles/strong-opinions/orphan.md",
      }),
    ];
    const violated = new Set<string>();
    const referenced = new Set<string>();
    const findings = checkOrphanPrinciples(principles, violated, referenced);
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_id).toBe("orphan");
    expect(findings[0].severity).toBe("strong-opinion");
    expect(findings[0].file_path).toBe("principles/strong-opinions/orphan.md");
    expect(findings[0].reason).toBe("zero violations AND zero references");
  });

  it("returns empty array when principles list is empty", () => {
    const findings = checkOrphanPrinciples([], new Set(), new Set());
    expect(findings).toHaveLength(0);
  });
});

// ---- checkStaleRefs ----

describe("checkStaleRefs", () => {
  it("returns no finding when a backtick path exists on disk", () => {
    const files = [{ path: "CLAUDE.md", content: "See `src/features/foo.ts` for details." }];
    const existsOnDisk = (_p: string) => true;
    const findings = checkStaleRefs(files, existsOnDisk);
    expect(findings).toHaveLength(0);
  });

  it("returns a finding with the correct line number for a missing backtick path", () => {
    const content = "Line one.\nSee `mcp-server/src/features/missing.ts` for details.";
    const files = [{ path: "CLAUDE.md", content }];
    const existsOnDisk = (_p: string) => false;
    const findings = checkStaleRefs(files, existsOnDisk);
    expect(findings).toHaveLength(1);
    expect(findings[0].source_file).toBe("CLAUDE.md");
    expect(findings[0].referenced_path).toBe("mcp-server/src/features/missing.ts");
    expect(findings[0].line_number).toBe(2);
  });

  it("skips https:// URLs", () => {
    const files = [
      { path: "CLAUDE.md", content: "See `https://example.com/foo.ts` for reference." },
    ];
    const existsOnDisk = (_p: string) => false;
    const findings = checkStaleRefs(files, existsOnDisk);
    expect(findings).toHaveLength(0);
  });

  it("skips paths with no directory component (bare filenames)", () => {
    const files = [{ path: "CLAUDE.md", content: "See `foo.ts` for details." }];
    const existsOnDisk = (_p: string) => false;
    const findings = checkStaleRefs(files, existsOnDisk);
    expect(findings).toHaveLength(0);
  });
});

// ---- checkMissingExamples ----

describe("checkMissingExamples", () => {
  it("returns no finding for a principle with a populated Examples section", () => {
    const p = makePrinciple({
      id: "with-examples",
      body: "Some text.\n\n## Examples\n\nThis is an example.",
    });
    const findings = checkMissingExamples([p]);
    expect(findings).toHaveLength(0);
  });

  it("flags a principle with no Examples section at all", () => {
    const p = makePrinciple({
      id: "no-examples",
      severity: "rule",
      filePath: "principles/rules/no-examples.md",
      body: "Some text with no examples heading.",
    });
    const findings = checkMissingExamples([p]);
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_id).toBe("no-examples");
    expect(findings[0].severity).toBe("rule");
    expect(findings[0].file_path).toBe("principles/rules/no-examples.md");
  });

  it("flags a principle with an empty Examples section", () => {
    const p = makePrinciple({
      id: "empty-examples",
      body: "Some text.\n\n## Examples\n\n   \n\n## Next Section\n\nContent.",
    });
    const findings = checkMissingExamples([p]);
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_id).toBe("empty-examples");
  });

  it("returns empty array for empty principles list", () => {
    const findings = checkMissingExamples([]);
    expect(findings).toHaveLength(0);
  });
});

// ---- assembleWikiLintOutput ----

describe("assembleWikiLintOutput", () => {
  it("assembles all arrays and computes correct summary counts", () => {
    const contradiction = {
      entity: "worktree",
      file_a: "a.md",
      claim_a: "must use",
      file_b: "b.md",
      claim_b: "never use",
    };
    const orphan = {
      principle_id: "foo",
      severity: "convention",
      file_path: "p.md",
      reason: "zero violations AND zero references",
    };
    const staleRef = { source_file: "CLAUDE.md", referenced_path: "src/gone.ts", line_number: 5 };
    const missingExample = {
      principle_id: "bar",
      severity: "rule",
      file_path: "bar.md",
    };

    const output = assembleWikiLintOutput({
      contradictions: [contradiction],
      orphans: [orphan],
      staleRefs: [staleRef],
      missingExamples: [missingExample],
      filesScanned: 10,
      principlesChecked: 20,
    });

    expect(output.contradictions).toHaveLength(1);
    expect(output.orphan_principles).toHaveLength(1);
    expect(output.stale_refs).toHaveLength(1);
    expect(output.missing_examples).toHaveLength(1);
    expect(output.summary.total_findings).toBe(4);
    expect(output.summary.files_scanned).toBe(10);
    expect(output.summary.principles_checked).toBe(20);
  });
});
