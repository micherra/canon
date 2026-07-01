/**
 * run-summary-extractors.test.ts
 *
 * Tests for extractNotableResolution — the pure, never-throw extractor that
 * pulls the digest's frozen `**Notable resolution**:` line from an engineer
 * SUMMARY (preferred) or architect DESIGN.md (fallback).
 */

import { describe, expect, test } from "vitest";
import { extractNotableResolution } from "../run-summary-extractors.ts";

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
    expect(result).toBe(
      "Deterministic and never-throw, matches sibling extractors",
    );
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
    expect(result).toBe(
      "Line one of the reason Line two of the reason Line three of the reason",
    );
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
