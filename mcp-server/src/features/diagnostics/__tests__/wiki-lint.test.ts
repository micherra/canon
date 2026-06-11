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

import { DEFAULT_LAYER_MAPPINGS, VALID_LAYERS } from "@shared/lib/config.ts";
import type { Principle } from "@shared/parser.ts";
import { describe, expect, it } from "vitest";
import {
  assembleWikiLintOutput,
  checkCitedPaths,
  checkContradictions,
  checkMissingExamples,
  checkOrphanPrinciples,
  checkScopeLayers,
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

// ---- checkScopeLayers ----

describe("checkScopeLayers", () => {
  it("VALID_LAYERS is derived from DEFAULT_LAYER_MAPPINGS keys (not hardcoded)", () => {
    expect(Array.from(VALID_LAYERS).sort()).toEqual(Object.keys(DEFAULT_LAYER_MAPPINGS).sort());
  });

  it("flags a principle with a single invalid layer name", () => {
    const p = makePrinciple({ id: "bad-layer", scope: { layers: ["bogus"], file_patterns: [] } });
    const findings = checkScopeLayers([p], VALID_LAYERS);
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_id).toBe("bad-layer");
    expect(findings[0].invalid_layers).toEqual(["bogus"]);
  });

  it("returns zero findings for all-valid layers", () => {
    const p = makePrinciple({
      id: "valid-layers",
      scope: { layers: ["api", "domain"], file_patterns: [] },
    });
    const findings = checkScopeLayers([p], VALID_LAYERS);
    expect(findings).toHaveLength(0);
  });

  it("returns zero findings for empty layers array", () => {
    const p = makePrinciple({ id: "empty-layers", scope: { layers: [], file_patterns: [] } });
    const findings = checkScopeLayers([p], VALID_LAYERS);
    expect(findings).toHaveLength(0);
  });

  it("flags only the invalid layer in a mixed valid+invalid list", () => {
    const p = makePrinciple({
      id: "mixed-layers",
      scope: { layers: ["domain", "service"], file_patterns: [] },
    });
    const findings = checkScopeLayers([p], VALID_LAYERS);
    expect(findings).toHaveLength(1);
    expect(findings[0].invalid_layers).toEqual(["service"]);
    // valid layer must not appear in invalid_layers
    expect(findings[0].invalid_layers).not.toContain("domain");
  });

  it("AC-2: finding message names offending layer, valid set, and remedy phrase", () => {
    const p = makePrinciple({
      id: "msg-test",
      scope: { layers: ["service"], file_patterns: [] },
    });
    const findings = checkScopeLayers([p], VALID_LAYERS);
    expect(findings).toHaveLength(1);
    const msg = findings[0].message;
    // Names the offending layer
    expect(msg).toContain("service");
    // Lists each valid layer name
    for (const layer of VALID_LAYERS) {
      expect(msg).toContain(layer);
    }
    // Includes remedy phrase
    expect(msg).toContain("set layers: []");
    expect(msg).toContain("file_patterns");
  });

  it("returns zero findings for an empty principles list", () => {
    const findings = checkScopeLayers([], VALID_LAYERS);
    expect(findings).toHaveLength(0);
  });

  it("emits one finding per principle with invalid layers (multiple principles)", () => {
    const p1 = makePrinciple({ id: "p1", scope: { layers: ["features"], file_patterns: [] } });
    const p2 = makePrinciple({ id: "p2", scope: { layers: ["api"], file_patterns: [] } });
    const p3 = makePrinciple({ id: "p3", scope: { layers: ["service"], file_patterns: [] } });
    const findings = checkScopeLayers([p1, p2, p3], VALID_LAYERS);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.principle_id).sort()).toEqual(["p1", "p3"]);
  });

  it("scalar scope.layers (YAML authoring typo) → finding with malformed message, does not throw", () => {
    // Simulate parser.ts unvalidated cast: scalar string instead of string[]
    const p = makePrinciple({
      id: "scalar-layers",
      scope: { layers: "api" as unknown as string[], file_patterns: [] },
    });
    let threw = false;
    let findings: ReturnType<typeof checkScopeLayers> = [];
    try {
      findings = checkScopeLayers([p], VALID_LAYERS);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // A scalar scope.layers is malformed — must be flagged (not silently skipped)
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_id).toBe("scalar-layers");
    expect(findings[0].message).toContain("must be a YAML list");
  });
});

// ---- checkCitedPaths (dc-06) ----

describe("checkCitedPaths", () => {
  it("dc-06a: flags a non-resolving cited path", () => {
    const files = [
      {
        path: "references/test.md",
        content: "Run `mcp-server/src/features/diagnostics/tools/wiki-lint.ts` to check.",
      },
    ];
    const existsOnDisk = (_p: string) => false;
    const findings = checkCitedPaths(files, existsOnDisk);
    expect(findings).toHaveLength(1);
    expect(findings[0].cited_path).toBe("mcp-server/src/features/diagnostics/tools/wiki-lint.ts");
    expect(findings[0].source_file).toBe("references/test.md");
  });

  it("dc-06b: passes a resolving cited path (no findings)", () => {
    const files = [
      {
        path: "references/test.md",
        content: "See `mcp-server/src/features/diagnostics/services/wiki-lint.ts` for details.",
      },
    ];
    const existsOnDisk = (_p: string) => true;
    const findings = checkCitedPaths(files, existsOnDisk);
    expect(findings).toHaveLength(0);
  });

  it("dc-06c: excludes ${WORKSPACE}/x.ts (template variable)", () => {
    const files = [
      {
        path: "references/test.md",
        content: "Write to `${WORKSPACE}/plans/x.ts` in the workspace.",
      },
    ];
    const existsOnDisk = (_p: string) => false;
    const findings = checkCitedPaths(files, existsOnDisk);
    expect(findings).toHaveLength(0);
  });

  it("dc-06c: excludes <stem>-SUMMARY.md placeholder", () => {
    const files = [
      {
        path: "references/test.md",
        content: "The summary is written to `<stem>-SUMMARY.md`.",
      },
    ];
    const existsOnDisk = (_p: string) => false;
    const findings = checkCitedPaths(files, existsOnDisk);
    expect(findings).toHaveLength(0);
  });

  it("dc-06c: excludes {slug}-SUMMARY.md brace placeholder", () => {
    const files = [
      {
        path: "references/test.md",
        content: "The agent writes `{slug}-SUMMARY.md` to the workspace.",
      },
    ];
    const existsOnDisk = (_p: string) => false;
    const findings = checkCitedPaths(files, existsOnDisk);
    expect(findings).toHaveLength(0);
  });

  it("dc-06d: ignores a path inside a fenced block labeled 'example'", () => {
    const files = [
      {
        path: "references/test.md",
        content: [
          "Normal text.",
          "```bash # example",
          "run mcp-server/src/missing-file.ts",
          "```",
          "End of doc.",
        ].join("\n"),
      },
    ];
    const existsOnDisk = (_p: string) => false;
    const findings = checkCitedPaths(files, existsOnDisk);
    expect(findings).toHaveLength(0);
  });

  it("dc-06d: ignores a path inside a fenced block labeled 'hypothetical'", () => {
    const files = [
      {
        path: "references/test.md",
        content: [
          "Some prose.",
          "```typescript # hypothetical",
          "// This references `src/missing.ts`",
          "```",
          "End.",
        ].join("\n"),
      },
    ];
    const existsOnDisk = (_p: string) => false;
    const findings = checkCitedPaths(files, existsOnDisk);
    expect(findings).toHaveLength(0);
  });

  it("dc-06d: does NOT strip regular fenced blocks (only illustrative ones)", () => {
    const files = [
      {
        path: "references/test.md",
        content: [
          "Real content:",
          "```typescript",
          "// import from `src/actually-missing.ts`",
          "```",
        ].join("\n"),
      },
    ];
    const existsOnDisk = (_p: string) => false;
    const findings = checkCitedPaths(files, existsOnDisk);
    // Regular fenced blocks are NOT stripped, so the backtick path inside is scanned
    expect(findings).toHaveLength(1);
    expect(findings[0].cited_path).toBe("src/actually-missing.ts");
  });

  it("dc-06e: reports the correct 1-based line_number", () => {
    const files = [
      {
        path: "references/test.md",
        content: "Line 1.\nLine 2.\nSee `src/features/missing.ts` on line 3.",
      },
    ];
    const existsOnDisk = (_p: string) => false;
    const findings = checkCitedPaths(files, existsOnDisk);
    expect(findings).toHaveLength(1);
    expect(findings[0].line_number).toBe(3);
  });

  it("dc-06: excludes bare filenames (no slash)", () => {
    const files = [
      {
        path: "references/test.md",
        content: "Use `package.json` in the root.",
      },
    ];
    const existsOnDisk = (_p: string) => false;
    const findings = checkCitedPaths(files, existsOnDisk);
    expect(findings).toHaveLength(0);
  });

  it("dc-06: excludes http:// URLs", () => {
    const files = [
      {
        path: "references/test.md",
        content: "See `http://example.com/foo.ts` for info.",
      },
    ];
    const existsOnDisk = (_p: string) => false;
    const findings = checkCitedPaths(files, existsOnDisk);
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

    const citedPath = {
      source_file: "references/test.md",
      cited_path: "src/missing.ts",
      line_number: 1,
    };

    const scopeLayer = {
      principle_id: "baz",
      file_path: "principles/conventions/baz.md",
      invalid_layers: ["service"],
      message: "Principle 'baz' declares invalid scope.layers: service.",
    };

    const glossaryFinding = {
      kind: "exact-duplicate" as const,
      line_numbers: [3, 6],
      term: "wave",
    };

    const output = assembleWikiLintOutput({
      citedPaths: [citedPath],
      contradictions: [contradiction],
      filesScanned: 10,
      glossaryConsistency: [glossaryFinding],
      missingExamples: [missingExample],
      orphans: [orphan],
      principlesChecked: 20,
      scopeLayers: [scopeLayer],
      scopeTags: [],
      indexDrift: [],
      staleRefs: [staleRef],
    });

    expect(output.contradictions).toHaveLength(1);
    expect(output.orphan_principles).toHaveLength(1);
    expect(output.stale_refs).toHaveLength(1);
    expect(output.missing_examples).toHaveLength(1);
    expect(output.cited_paths).toHaveLength(1);
    expect(output.scope_layers).toHaveLength(1);
    expect(output.glossary_consistency).toHaveLength(1);
    expect(output.summary.total_findings).toBe(7);
    expect(output.summary.files_scanned).toBe(10);
    expect(output.summary.principles_checked).toBe(20);
  });
});
