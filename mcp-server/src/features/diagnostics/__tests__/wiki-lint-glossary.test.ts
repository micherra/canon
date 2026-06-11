/**
 * Unit tests for checkGlossaryConsistency.
 *
 * Test plan:
 * - clean glossary (3 distinct headings) → []
 * - exact-duplicate (## Wave twice) → 1 finding with kind "exact-duplicate"
 * - naked-vs-qualified (## Tier AND ## Tier (Build Tier)) → 1 finding with kind "naked-vs-qualified"
 * - allowed disambiguation (## Tier (Autonomy Tier) + ## Tier (Build Tier), no naked) → []
 * - finding shape: term, kind, and 1-based line_numbers[] are all present and correct
 */

import { describe, expect, it } from "vitest";
import { checkGlossaryConsistency } from "../services/wiki-lint-glossary.ts";

describe("checkGlossaryConsistency", () => {
  it("clean glossary (3 distinct headings) → []", () => {
    const content = [
      "# Context",
      "",
      "## Wave",
      "A wave is a group of parallel tasks.",
      "",
      "## Tier (Autonomy Tier)",
      "Autonomy tier is the risk classification.",
      "",
      "## Tier (Build Tier)",
      "Build tier is the complexity classification.",
    ].join("\n");
    const findings = checkGlossaryConsistency({ content, path: "CONTEXT.md" });
    expect(findings).toEqual([]);
  });

  it("exact-duplicate (## Wave twice) → 1 finding with kind exact-duplicate", () => {
    const content = [
      "# Context",
      "",
      "## Wave",
      "A wave is a group of parallel tasks.",
      "",
      "## Wave",
      "A second wave definition.",
    ].join("\n");
    const findings = checkGlossaryConsistency({ content, path: "CONTEXT.md" });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("exact-duplicate");
    expect(findings[0].term).toBe("wave");
    expect(findings[0].line_numbers).toHaveLength(2);
    // Both occurrences are on lines 3 and 6 (1-based)
    expect(findings[0].line_numbers).toContain(3);
    expect(findings[0].line_numbers).toContain(6);
  });

  it("naked-vs-qualified (## Tier AND ## Tier (Build Tier)) → 1 finding with kind naked-vs-qualified", () => {
    const content = [
      "# Context",
      "",
      "## Tier",
      "A tier definition.",
      "",
      "## Tier (Build Tier)",
      "Build tier is the complexity classification.",
    ].join("\n");
    const findings = checkGlossaryConsistency({ content, path: "CONTEXT.md" });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("naked-vs-qualified");
    expect(findings[0].term).toBe("tier");
    expect(findings[0].line_numbers).toHaveLength(2);
    expect(findings[0].line_numbers).toContain(3);
    expect(findings[0].line_numbers).toContain(6);
  });

  it("allowed disambiguation (## Tier (Autonomy Tier) + ## Tier (Build Tier), no naked) → []", () => {
    const content = [
      "# Context",
      "",
      "## Tier (Autonomy Tier)",
      "Autonomy tier is the risk classification.",
      "",
      "## Tier (Build Tier)",
      "Build tier is the complexity classification.",
    ].join("\n");
    const findings = checkGlossaryConsistency({ content, path: "CONTEXT.md" });
    expect(findings).toEqual([]);
  });

  it("duplicate naked + qualified → BOTH exact-duplicate AND naked-vs-qualified findings in one pass", () => {
    // Scenario: ## Tier (line 3), ## Tier (line 6), ## Tier (Build Tier) (line 9)
    // Expected: exact-duplicate for lines [3,6], AND naked-vs-qualified for line [9]
    const content = [
      "# Context", // line 1
      "", // line 2
      "## Tier", // line 3
      "First naked definition.", // line 4
      "", // line 5
      "## Tier", // line 6
      "Second naked definition (duplicate).", // line 7
      "", // line 8
      "## Tier (Build Tier)", // line 9
      "Qualified tier definition.", // line 10
    ].join("\n");
    const findings = checkGlossaryConsistency({ content, path: "CONTEXT.md" });
    expect(findings).toHaveLength(2);

    const dupFinding = findings.find((f) => f.kind === "exact-duplicate");
    const nvqFinding = findings.find((f) => f.kind === "naked-vs-qualified");

    expect(dupFinding).toBeDefined();
    expect(dupFinding?.term).toBe("tier");
    expect(dupFinding?.line_numbers).toEqual(expect.arrayContaining([3, 6]));
    expect(dupFinding?.line_numbers).toHaveLength(2);

    expect(nvqFinding).toBeDefined();
    expect(nvqFinding?.term).toBe("tier");
    // Lines 3 and 6 are already in the exact-duplicate finding; only line 9 remains
    expect(nvqFinding?.line_numbers).toContain(9);
    // Must NOT double-report lines already in the exact-duplicate finding
    expect(nvqFinding?.line_numbers).not.toContain(3);
    expect(nvqFinding?.line_numbers).not.toContain(6);
  });

  it("finding shape: term, kind, and 1-based line_numbers are all present and correct", () => {
    const content = [
      "# Context", // line 1
      "", // line 2
      "## Sprint", // line 3
      "First definition.", // line 4
      "", // line 5
      "## Sprint", // line 6
      "Second definition.", // line 7
    ].join("\n");
    const findings = checkGlossaryConsistency({ content, path: "CONTEXT.md" });
    expect(findings).toHaveLength(1);
    const f = findings[0];
    // term must be normalized (lowercase)
    expect(f.term).toBe("sprint");
    // kind must be the string literal
    expect(f.kind).toBe("exact-duplicate");
    // line_numbers must be an array of numbers, 1-based
    expect(Array.isArray(f.line_numbers)).toBe(true);
    expect(f.line_numbers.every((n) => typeof n === "number" && n >= 1)).toBe(true);
    expect(f.line_numbers).toEqual([3, 6]);
  });
});
