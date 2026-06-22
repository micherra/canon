/**
 * Tests for checkScopeTags and assembleWikiLintOutput scope_tags inclusion.
 *
 * New sibling test file — wiki-lint.test.ts is at ~534/600 lines.
 *
 * Test plan:
 * checkScopeTags:
 * 1. principle with scope.tags: ["bogus-tag"] → one finding; invalid_tags: ["bogus-tag"]
 * 2. principle with scope.tags: ["error-handling"] (valid) → no findings
 * 3. principle with absent scope.tags → no findings
 * 4. principle with scope.tags: [] → no findings
 * 5. mixed ["error-handling", "design"] → one finding listing only "design"
 * 6. empty principles array → no findings
 *
 * assembleWikiLintOutput:
 * 7. includes scope_tags in output and counts findings in summary.total_findings
 */

import type { Principle } from "@shared/parser.ts";
import { describe, expect, it } from "vitest";
import { assembleWikiLintOutput, checkScopeTags } from "../services/wiki-lint.ts";

// ---- Helpers ----

const VALID_TAGS: readonly string[] = [
  "graph-infrastructure",
  "orchestration",
  "principles",
  "pr-review",
  "file-context",
  "knowledge-graph",
  "diagnostics",
  "infrastructure",
  "shared-kernel",
  "frontend",
  "error-handling",
  "observability",
  "hub",
  "entry-point",
  "leaf",
];

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

// ---- checkScopeTags ----

describe("checkScopeTags", () => {
  it("1: principle with single invalid scope.tag → one finding with invalid_tags", () => {
    const p = makePrinciple({
      id: "bad-tag",
      scope: { layers: [], file_patterns: [], tags: ["bogus-tag"] },
    });
    const findings = checkScopeTags([p], VALID_TAGS);
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_id).toBe("bad-tag");
    expect(findings[0].invalid_tags).toEqual(["bogus-tag"]);
    expect(findings[0].message).toContain("bogus-tag");
    expect(findings[0].message).toContain("scope.file_patterns");
  });

  it("2: principle with valid scope.tag → no findings", () => {
    const p = makePrinciple({
      id: "valid-tag",
      scope: { layers: [], file_patterns: [], tags: ["error-handling"] },
    });
    const findings = checkScopeTags([p], VALID_TAGS);
    expect(findings).toHaveLength(0);
  });

  it("3: principle with absent scope.tags → no findings", () => {
    const p = makePrinciple({
      id: "no-tags",
      scope: { layers: [], file_patterns: [] },
    });
    const findings = checkScopeTags([p], VALID_TAGS);
    expect(findings).toHaveLength(0);
  });

  it("4: principle with empty scope.tags array → no findings", () => {
    const p = makePrinciple({
      id: "empty-tags",
      scope: { layers: [], file_patterns: [], tags: [] },
    });
    const findings = checkScopeTags([p], VALID_TAGS);
    expect(findings).toHaveLength(0);
  });

  it("5: mixed valid+invalid scope.tags → one finding listing only invalid tags", () => {
    const p = makePrinciple({
      id: "mixed-tags",
      scope: { layers: [], file_patterns: [], tags: ["error-handling", "design"] },
    });
    const findings = checkScopeTags([p], VALID_TAGS);
    expect(findings).toHaveLength(1);
    expect(findings[0].invalid_tags).toEqual(["design"]);
    expect(findings[0].invalid_tags).not.toContain("error-handling");
  });

  it("6: empty principles array → no findings", () => {
    const findings = checkScopeTags([], VALID_TAGS);
    expect(findings).toHaveLength(0);
  });

  it("7: scalar scope.tags (YAML authoring typo) → finding with malformed message, does not throw", () => {
    // Parser unvalidated cast produces scope.tags === "error-handling" (string)
    // checkScopeTags must not throw TypeError: p.scope.tags.filter is not a function
    const p = makePrinciple({
      id: "scalar-tags",
      scope: {
        layers: [],
        file_patterns: [],
        // Simulate parser.ts unvalidated cast: scalar string instead of string[]
        tags: "error-handling" as unknown as string[],
      },
    });
    let threw = false;
    let findings: ReturnType<typeof checkScopeTags> = [];
    try {
      findings = checkScopeTags([p], VALID_TAGS);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // A scalar scope.tags is malformed — must be flagged (not silently skipped)
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_id).toBe("scalar-tags");
    expect(findings[0].message).toContain("must be a YAML list");
  });
});

// ---- assembleWikiLintOutput — scope_tags integration ----

describe("assembleWikiLintOutput with scope_tags", () => {
  it("7: includes scope_tags in output and counts findings in total_findings", () => {
    const scopeTagFinding = {
      principle_id: "bad-tag",
      file_path: "principles/conventions/bad-tag.md",
      invalid_tags: ["design"],
      message:
        "Principle 'bad-tag' declares scope.tags outside the KG computed-tag vocabulary: design.",
    };
    const output = assembleWikiLintOutput({
      citedPaths: [],
      contradictions: [],
      duplicateTitles: [],
      filesScanned: 1,
      frontmatterSchema: [],
      glossaryConsistency: [],
      missingExamples: [],
      misroutedPrinciples: [],
      orphans: [],
      principlesChecked: 1,
      scopeLayers: [],
      scopeTags: [scopeTagFinding],
      indexDrift: [],
      staleRefs: [],
    });

    expect(output).toHaveProperty("scope_tags");
    expect(output.scope_tags).toHaveLength(1);
    expect(output.scope_tags[0].principle_id).toBe("bad-tag");
    expect(output.summary.total_findings).toBe(1);
  });

  it("assembleWikiLintOutput: zero scope_tags does not affect total_findings", () => {
    const output = assembleWikiLintOutput({
      citedPaths: [],
      contradictions: [],
      duplicateTitles: [],
      filesScanned: 0,
      frontmatterSchema: [],
      glossaryConsistency: [],
      missingExamples: [],
      misroutedPrinciples: [],
      orphans: [],
      principlesChecked: 0,
      scopeLayers: [],
      scopeTags: [],
      indexDrift: [],
      staleRefs: [],
    });

    expect(output.scope_tags).toHaveLength(0);
    expect(output.summary.total_findings).toBe(0);
  });
});
