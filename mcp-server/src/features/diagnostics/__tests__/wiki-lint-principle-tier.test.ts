/**
 * Unit tests for wiki-lint-principle-tier.ts — pure check functions.
 *
 * Test plan:
 * - checkMisroutedPrinciples:
 *   - portable:false under principles/ (shipped tier) → 1 finding
 *   - portable:false under .canon/principles/ → 0 findings (not shipped tier)
 *   - portable:true universal file → 0 findings
 *   - shipped file with all-Canon-internal file_patterns (no portable flag) → 1 finding
 *   - shipped file with empty file_patterns → 0 findings (not all-Canon-internal)
 * - checkDuplicateTitles:
 *   - two principles with near-identical titles ("Detection Tools Emit Audit Events"
 *     vs "detection tools emit audit events.") → 1 finding
 *   - two principles with distinct titles → 0 findings
 *   - single principle → 0 findings
 * - normalizeTitle:
 *   - lowercase
 *   - whitespace collapse
 *   - trailing punctuation strip
 */

import type { Principle } from "@shared/parser.ts";
import { describe, expect, it } from "vitest";
import {
  checkDuplicateTitles,
  checkMisroutedPrinciples,
  normalizeTitle,
} from "../services/wiki-lint-principle-tier.ts";

// ---- Fixtures ----

function makePrinciple(
  overrides: Partial<Principle> & { filePath: string; id: string; title: string },
): Principle {
  return {
    archived: false,
    body: "Test principle body.",
    scope: { file_patterns: [], layers: [] },
    severity: "convention",
    tags: [],
    ...overrides,
  };
}

// ---- checkMisroutedPrinciples ----

describe("checkMisroutedPrinciples", () => {
  it("portable:false under principles/ (shipped tier) → 1 finding", () => {
    const p = makePrinciple({
      filePath: "/repo/principles/conventions/my-internal.md",
      id: "my-internal",
      title: "My Internal Principle",
      portable: false,
    });
    const findings = checkMisroutedPrinciples([p]);
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_id).toBe("my-internal");
    expect(findings[0].file_path).toBe("/repo/principles/conventions/my-internal.md");
    expect(findings[0].reason).toContain("portable");
  });

  it("portable:false under .canon/principles/ → 0 findings (already in internal tier)", () => {
    const p = makePrinciple({
      filePath: "/repo/.canon/principles/conventions/my-internal.md",
      id: "my-internal",
      title: "My Internal Principle",
      portable: false,
    });
    const findings = checkMisroutedPrinciples([p]);
    expect(findings).toHaveLength(0);
  });

  it("portable:true universal file under principles/ → 0 findings", () => {
    const p = makePrinciple({
      filePath: "/repo/principles/strong-opinions/universal.md",
      id: "universal",
      title: "Universal Principle",
      portable: true,
    });
    const findings = checkMisroutedPrinciples([p]);
    expect(findings).toHaveLength(0);
  });

  it("shipped file with all-Canon-internal file_patterns (no portable flag) → 1 finding (scope branch)", () => {
    const p = makePrinciple({
      filePath: "/repo/principles/conventions/scope-internal.md",
      id: "scope-internal",
      title: "Scope Internal Principle",
      scope: {
        file_patterns: ["mcp-server/", "hooks/"],
        layers: [],
      },
    });
    const findings = checkMisroutedPrinciples([p]);
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_id).toBe("scope-internal");
    expect(findings[0].reason).toContain("scope");
  });

  it("shipped file with empty file_patterns → 0 findings (universal by default, not misrouted)", () => {
    const p = makePrinciple({
      filePath: "/repo/principles/conventions/universal-empty-scope.md",
      id: "universal-empty-scope",
      title: "Universal Empty Scope",
      scope: { file_patterns: [], layers: [] },
    });
    const findings = checkMisroutedPrinciples([p]);
    expect(findings).toHaveLength(0);
  });

  it("shipped file with mixed file_patterns (some non-internal) → 0 findings", () => {
    const p = makePrinciple({
      filePath: "/repo/principles/conventions/mixed-scope.md",
      id: "mixed-scope",
      title: "Mixed Scope",
      scope: {
        file_patterns: ["mcp-server/", "src/"],
        layers: [],
      },
    });
    const findings = checkMisroutedPrinciples([p]);
    expect(findings).toHaveLength(0);
  });

  it("portable:undefined (absent) under principles/ with mixed scope → 0 findings (not all-internal)", () => {
    const p = makePrinciple({
      filePath: "/repo/principles/conventions/untagged.md",
      id: "untagged",
      title: "Untagged Principle",
      // portable is undefined (not set) — legacy/un-stamped
      scope: { file_patterns: ["src/features/"], layers: [] },
    });
    const findings = checkMisroutedPrinciples([p]);
    expect(findings).toHaveLength(0);
  });

  // NEW direction: portable:true stranded outside the shipped tier → 1 finding
  it("portable:true under .canon/principles/ → 1 finding (stranded outside shipped tier)", () => {
    const p = makePrinciple({
      filePath: "/repo/.canon/principles/conventions/universal.md",
      id: "universal",
      title: "Universal Principle",
      portable: true,
    });
    const findings = checkMisroutedPrinciples([p]);
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_id).toBe("universal");
    expect(findings[0].file_path).toBe("/repo/.canon/principles/conventions/universal.md");
    expect(findings[0].reason).toContain("portable: true");
  });

  it("portable:true under principles/ (correct location) → 0 findings", () => {
    const p = makePrinciple({
      filePath: "/repo/principles/conventions/correct.md",
      id: "correct",
      title: "Correct Principle",
      portable: true,
    });
    const findings = checkMisroutedPrinciples([p]);
    expect(findings).toHaveLength(0);
  });
});

// ---- checkDuplicateTitles ----

describe("checkDuplicateTitles", () => {
  it("two principles with near-identical titles (different case + trailing punctuation) → 1 finding", () => {
    const p1 = makePrinciple({
      filePath: "/repo/principles/conventions/audit-event-from-detection-tool.md",
      id: "audit-event-from-detection-tool",
      title: "Detection Tools Emit Audit Events",
    });
    const p2 = makePrinciple({
      filePath: "/repo/.canon/principles/conventions/fail-open-audit-event-emission.md",
      id: "fail-open-audit-event-emission",
      title: "detection tools emit audit events.",
    });
    const findings = checkDuplicateTitles([p1, p2]);
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_ids).toContain("audit-event-from-detection-tool");
    expect(findings[0].principle_ids).toContain("fail-open-audit-event-emission");
    expect(findings[0].file_paths).toHaveLength(2);
  });

  it("two principles with distinct titles → 0 findings", () => {
    const p1 = makePrinciple({
      filePath: "/repo/principles/conventions/first.md",
      id: "first",
      title: "First Principle",
    });
    const p2 = makePrinciple({
      filePath: "/repo/principles/conventions/second.md",
      id: "second",
      title: "Second Principle",
    });
    const findings = checkDuplicateTitles([p1, p2]);
    expect(findings).toHaveLength(0);
  });

  it("single principle → 0 findings", () => {
    const p = makePrinciple({
      filePath: "/repo/principles/conventions/single.md",
      id: "single",
      title: "Single Principle",
    });
    const findings = checkDuplicateTitles([p]);
    expect(findings).toHaveLength(0);
  });

  it("two principles with same normalized title (whitespace difference) → 1 finding", () => {
    const p1 = makePrinciple({
      filePath: "/repo/principles/rules/foo.md",
      id: "foo",
      title: "Fail  Closed  By  Default",
    });
    const p2 = makePrinciple({
      filePath: "/repo/.canon/principles/rules/bar.md",
      id: "bar",
      title: "fail closed by default",
    });
    const findings = checkDuplicateTitles([p1, p2]);
    expect(findings).toHaveLength(1);
  });

  it("three principles where two share a title → 1 finding with 2 IDs", () => {
    const p1 = makePrinciple({
      filePath: "/repo/principles/conventions/a.md",
      id: "a",
      title: "Shared Title",
    });
    const p2 = makePrinciple({
      filePath: "/repo/principles/conventions/b.md",
      id: "b",
      title: "Unique Title",
    });
    const p3 = makePrinciple({
      filePath: "/repo/.canon/principles/conventions/c.md",
      id: "c",
      title: "shared title.",
    });
    const findings = checkDuplicateTitles([p1, p2, p3]);
    expect(findings).toHaveLength(1);
    expect(findings[0].principle_ids).toContain("a");
    expect(findings[0].principle_ids).toContain("c");
    expect(findings[0].principle_ids).not.toContain("b");
  });
});

// ---- normalizeTitle ----

describe("normalizeTitle", () => {
  it("lowercases the title", () => {
    expect(normalizeTitle("UPPERCASE TITLE")).toBe("uppercase title");
  });

  it("collapses multiple whitespace", () => {
    expect(normalizeTitle("collapse  multiple   spaces")).toBe("collapse multiple spaces");
  });

  it("strips trailing period", () => {
    expect(normalizeTitle("Title With Period.")).toBe("title with period");
  });

  it("strips trailing comma", () => {
    expect(normalizeTitle("Title With Comma,")).toBe("title with comma");
  });

  it("strips trailing exclamation mark", () => {
    expect(normalizeTitle("Title!")).toBe("title");
  });

  it("does not strip mid-word punctuation", () => {
    expect(normalizeTitle("Don't do this.")).toBe("don't do this");
  });

  it("handles empty string", () => {
    expect(normalizeTitle("")).toBe("");
  });

  it("identical after normalization catches the audit-event pair", () => {
    const t1 = normalizeTitle("Detection Tools Emit Audit Events");
    const t2 = normalizeTitle("detection tools emit audit events.");
    expect(t1).toBe(t2);
  });
});
