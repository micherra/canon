/**
 * run-summary-extractors.test.ts
 *
 * Tests for extractNotableResolution — the pure, never-throw extractor that
 * pulls the digest's frozen `**Notable resolution**:` line from an engineer
 * SUMMARY (preferred) or architect DESIGN.md (fallback).
 *
 * Also covers the violations table parser (exercised through its only caller,
 * parseReviewFile) and the exported closed-domain charset guard. Every header
 * shape and prose cell below is a MEASURED shape from the real archived corpus
 * (PROBE-FINDINGS Findings 1, 2 and 6) — not an invented fixture.
 */

import { describe, expect, test } from "vitest";
import {
  extractNotableResolution,
  isPrincipleIdShaped,
  parseReviewFile,
} from "../run-summary-extractors.ts";

describe("extractNotableResolution", () => {
  test("### Decisions table present returns first-row rationale, single line", () => {
    const summary = `## Implementation Summary: my-task

### Files Changed

| Path | Action |
|------|--------|
| src/foo.ts | modified |

### Decisions

| # | Choice | Rationale | Informed By |
|---|--------|-----------|-------------|
| 1 | Use pure extractor | Deterministic and never-throw, matches sibling extractors | task_plan:success-01 |
`;

    const result = extractNotableResolution(summary);
    expect(result).toBe("Deterministic and never-throw, matches sibling extractors");
  });

  test("no ### Decisions, ### Deviations present returns first deviation reason", () => {
    const summary = `## Implementation Summary: my-task

### Files Changed

| Path | Action |
|------|--------|
| src/foo.ts | modified |

### Deviations

- **success-01**: Skipped the model-judged approach; deterministic extraction is simpler and sufficient
`;

    const result = extractNotableResolution(summary);
    expect(result).toBe(
      "Skipped the model-judged approach; deterministic extraction is simpler and sufficient",
    );
  });

  test("only designContent with ### Decisions made returns first bullet", () => {
    const design = `## Design

### Decisions made

- **Sub-analysis E under convention-lifecycle, not a new top-level dimension** — reuses the weighted-recurrence discipline
- Some other decision
`;

    const result = extractNotableResolution("", design);
    expect(result).toBe(
      "**Sub-analysis E under convention-lifecycle, not a new top-level dimension** — reuses the weighted-recurrence discipline",
    );
  });

  test("all empty / malformed / no sections returns empty string, never throws", () => {
    expect(extractNotableResolution("")).toBe("");
    expect(extractNotableResolution("no headings here at all")).toBe("");
    expect(extractNotableResolution("### Decisions\n\nnot a table")).toBe("");
    expect(() => extractNotableResolution(undefined as unknown as string)).not.toThrow();
  });

  test("summaryContent takes priority over designContent when both present", () => {
    const summary = `### Deviations

- **dev-01**: summary-sourced reason
`;
    const design = `### Decisions made

- design-sourced bullet
`;
    expect(extractNotableResolution(summary, design)).toBe("summary-sourced reason");
  });

  test(">200-char input is capped at 200 chars", () => {
    const longReason = "x".repeat(250);
    const summary = `### Deviations

- **dev-01**: ${longReason}
`;
    const result = extractNotableResolution(summary);
    expect(result.length).toBe(200);
  });

  test("multi-line reason text is collapsed to a single line", () => {
    const summary = `### Deviations

- **dev-01**: Line one of the reason
Line two of the reason
Line three of the reason
`;
    const result = extractNotableResolution(summary);
    expect(result).not.toContain("\n");
    expect(result).toBe("Line one of the reason Line two of the reason Line three of the reason");
  });

  test("does not confuse Decisions Applied bullet section with Decisions table", () => {
    const summary = `### Decisions Applied

- some prior decision id

### Deviations

- **dev-01**: real reason
`;
    const result = extractNotableResolution(summary);
    expect(result).toBe("real reason");
  });
});

// ---------------------------------------------------------------------------
// isPrincipleIdShaped — the closed-domain charset guard (ADR-0056)
// ---------------------------------------------------------------------------

describe("isPrincipleIdShaped", () => {
  test("accepts real principle ids", () => {
    expect(isPrincipleIdShaped("fail-closed-by-default")).toBe(true);
    expect(isPrincipleIdShaped("stage-2-code-quality")).toBe(true);
  });

  test("rejects template placeholders, camelCase, prose and too-short tokens", () => {
    expect(isPrincipleIdShaped("{id}")).toBe(false);
    expect(isPrincipleIdShaped("noExcessiveLinesPerFile")).toBe(false);
    expect(isPrincipleIdShaped("—")).toBe(false);
    expect(isPrincipleIdShaped("ab")).toBe(false);
  });

  test("parse is not resolve: a charset-valid but retired id is accepted", () => {
    expect(isPrincipleIdShaped("thin-handlers")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractViolationsSection (via its only caller, parseReviewFile)
// ---------------------------------------------------------------------------

/** Wrap a `#### Violations` body in the minimal REVIEW.md frontmatter parseReviewFile needs. */
function review(violationsBody: string): string {
  return `---
verdict: BLOCKING
files-reviewed: 3
principles-checked: 12
---

### Principle Compliance

#### Violations
${violationsBody}

#### Honored
- **errors-are-values**: typed results throughout
`;
}

function violationsOf(violationsBody: string) {
  return parseReviewFile(review(violationsBody))?.violations ?? [];
}

describe("extractViolationsSection — the six measured header shapes", () => {
  test("| Principle | Severity | Location | Confidence | (249 archives)", () => {
    const violations = violationsOf(`| Principle | Severity | Location | Confidence |
|-----------|----------|----------|------------|
| fail-closed-by-default | rule | \`src/foo.ts:12\` | HIGH |`);

    expect(violations).toEqual([
      {
        file_path: "src/foo.ts:12",
        message: "",
        principle_id: "fail-closed-by-default",
        severity: "rule",
      },
    ]);
  });

  test("| Principle | Severity | Location | (53 archives)", () => {
    const violations = violationsOf(`| Principle | Severity | Location |
|-----------|----------|----------|
| thin-handlers | convention | \`src/bar.ts:3\` |`);

    expect(violations).toHaveLength(1);
    expect(violations[0].principle_id).toBe("thin-handlers");
    expect(violations[0].file_path).toBe("src/bar.ts:3");
  });

  test("| Principle | Severity | Location | Confidence | Description | Fix | (20 archives)", () => {
    const violations =
      violationsOf(`| Principle | Severity | Location | Confidence | Description | Fix |
|-----------|----------|----------|------------|-------------|-----|
| errors-are-values | rule | \`src/baz.ts:9\` | HIGH | throws on expected condition | return a typed result |`);

    expect(violations).toEqual([
      {
        file_path: "src/baz.ts:9",
        message: "throws on expected condition",
        principle_id: "errors-are-values",
        severity: "rule",
      },
    ]);
  });

  test("| Principle | Severity | File | Description | Fix | (12 archives — location column named File)", () => {
    const violations = violationsOf(`| Principle | Severity | File | Description | Fix |
|-----------|----------|------|-------------|-----|
| single-source-of-truth | strong-opinion | \`src/qux.ts\` | duplicated constant | import the shared one |`);

    expect(violations).toEqual([
      {
        file_path: "src/qux.ts",
        message: "duplicated constant",
        principle_id: "single-source-of-truth",
        severity: "strong-opinion",
      },
    ]);
  });

  test("| # | Principle | Severity | Location | Description | — the ordinal is never recorded as a principle id", () => {
    const violations = violationsOf(`| # | Principle | Severity | Location | Description |
|---|-----------|----------|----------|-------------|
| 1 | no-dead-abstractions | convention | \`src/a.ts:1\` | unused export |
| 2 | explicit-contracts | rule | \`src/b.ts:2\` | implicit shape |`);

    expect(violations.map((v) => v.principle_id)).toEqual([
      "no-dead-abstractions",
      "explicit-contracts",
    ]);
    // The falsified positional parser would have recorded "1"/"2" here.
    expect(violations.map((v) => v.principle_id)).not.toContain("1");
  });

  test("| # | Principle | Severity | File | Description | Fix |", () => {
    const violations = violationsOf(`| # | Principle | Severity | File | Description | Fix |
|---|-----------|----------|------|-------------|-----|
| 1 | validate-at-trust-boundaries | rule | \`src/c.ts\` | unvalidated input | add a closed-domain guard |`);

    expect(violations).toEqual([
      {
        file_path: "src/c.ts",
        message: "unvalidated input",
        principle_id: "validate-at-trust-boundaries",
        severity: "rule",
      },
    ]);
  });
});

describe("extractViolationsSection — escaped pipes (PROBE-FINDINGS Finding 2)", () => {
  test("a cell containing {HIGH\\|MEDIUM\\|LOW} parses without shifting columns", () => {
    const violations =
      violationsOf(`| Principle | Severity | Location | Confidence | Description | Fix |
|-----------|----------|----------|------------|-------------|-----|
| fail-closed-by-default | rule | \`src/foo.ts:12\` | {HIGH\\|MEDIUM\\|LOW} | fails open on error | fail closed |`);

    expect(violations).toEqual([
      {
        file_path: "src/foo.ts:12",
        message: "fails open on error",
        principle_id: "fail-closed-by-default",
        severity: "rule",
      },
    ]);
  });

  test("the escaped pipe is unescaped within its own cell, not treated as a boundary", () => {
    const violations = violationsOf(`| Principle | Severity | Location | Description |
|-----------|----------|----------|-------------|
| errors-are-values | rule | \`src/foo.ts:1\` | rejects {a\\|b} shapes |`);

    expect(violations[0].message).toBe("rejects {a|b} shapes");
  });
});

describe("extractViolationsSection — the charset guard never coerces (ADR-0056)", () => {
  test("every measured prose cell is skipped, not recorded", () => {
    const violations = violationsOf(`| Principle | Severity | Location |
|-----------|----------|----------|
| — | — | — |
| _(none)_ | — | — |
| M5-fail-direction-characterization | rule | \`src/a.ts\` |
| scope-boundary-correct (codex Class 3 — scope too narrow) | rule | \`src/b.ts\` |`);

    expect(violations).toEqual([]);
  });

  test("a charset-valid but retired id is RETAINED — parse is not resolve", () => {
    const violations = violationsOf(`| Principle | Severity | Location |
|-----------|----------|----------|
| thin-handlers | convention | \`src/a.ts:1\` |`);

    expect(violations.map((v) => v.principle_id)).toEqual(["thin-handlers"]);
  });

  test("prose rows are dropped while valid rows in the same table survive", () => {
    const violations = violationsOf(`| Principle | Severity | Location |
|-----------|----------|----------|
| — | — | — |
| errors-are-values | rule | \`src/a.ts:1\` |`);

    expect(violations.map((v) => v.principle_id)).toEqual(["errors-are-values"]);
  });
});

describe("extractViolationsSection — degenerate input returns [] and never throws", () => {
  test("a table with no Principle column yields no violations", () => {
    const violations = violationsOf(`| Severity | Location | Description |
|----------|----------|-------------|
| rule | \`src/a.ts:1\` | something |`);

    expect(violations).toEqual([]);
  });

  test("header + separator only (empty table) yields no violations", () => {
    expect(
      violationsOf(`| Principle | Severity | Location |
|-----------|----------|----------|`),
    ).toEqual([]);
  });

  test("the ~20 real sentinel bodies yield no violations", () => {
    for (const sentinel of [
      "None.",
      "No violations found.",
      "_None._",
      "No principle violations found.",
      "",
      "Nothing of note — the diff is clean.",
    ]) {
      expect(violationsOf(sentinel)).toEqual([]);
    }
  });

  test("malformed and truncated tables return [] without throwing", () => {
    expect(() => violationsOf("| Principle | Severity")).not.toThrow();
    expect(violationsOf("| Principle | Severity")).toEqual([]);
    expect(() =>
      violationsOf(`| Principle | Severity | Location |
|-----------|`),
    ).not.toThrow();
  });

  test("a missing severity cell degrades to 'unknown' rather than fabricating one", () => {
    const violations = violationsOf(`| Principle | Severity | Location |
|-----------|----------|----------|
| errors-are-values |  | \`src/a.ts:1\` |`);

    expect(violations[0].severity).toBe("unknown");
  });

  test("an empty location cell degrades to null", () => {
    const violations = violationsOf(`| Principle | Severity | Location |
|-----------|----------|----------|
| errors-are-values | rule |  |`);

    expect(violations[0].file_path).toBeNull();
  });
});
