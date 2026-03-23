import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  executeEffects,
  parseReviewArtifact,
  parseDecisionsFromSummary,
} from "../orchestration/effects.js";
import type { StateDefinition } from "../orchestration/flow-schema.js";

const SAMPLE_REVIEW = `---
verdict: "WARNING"
agent: canon-reviewer
timestamp: "2026-03-23T10:00:00Z"
files-reviewed: 3
principles-checked: 5
---

## Canon Review — Verdict: WARNING

### Principle Compliance

#### Violations
<!-- Ordered by impact score -->
| Principle | Severity | File | Description | Fix |
|-----------|----------|------|-------------|-----|
| thin-handlers | strong-opinion | \`src/api/orders.ts:42\` | Business logic in handler | Extract to service |
| validate-at-boundaries | rule | \`src/api/orders.ts:15\` | Raw input used without validation | Add zod schema |

#### Honored
<!-- Brief notes on principles the code follows well. -->
- **naming-reveals-intent**: Clear function and variable names throughout
- **errors-are-values**: Proper Result type usage in service layer

#### Score
| Layer | Rules | Opinions | Conventions |
|-------|-------|----------|-------------|
| api | 1/2 | 2/3 | 1/1 |
| service | 2/2 | 1/1 | 0/0 |

### Code Quality (Advisory)

#### Suggestions
- **Readability**: Consider extracting the order validation into a separate function
`;

const SAMPLE_SUMMARY = `---
task-id: "task-01"
status: "DONE"
agent: canon-implementor
timestamp: "2026-03-23T10:00:00Z"
commit: "abc123"
---

## Implementation: task-01

### What Changed
Added order validation service.

### Files
| File | Action | Purpose |
|------|--------|---------|
| \`src/api/orders.ts\` | modified | Added validation |
| \`src/services/order-validator.ts\` | created | Validation logic |

### Tests Written
| Test File | Count | Coverage |
|-----------|-------|----------|
| \`src/services/order-validator.test.ts\` | 5 | happy path, error cases |

### Coverage Notes
#### Tested Paths
- validateOrder: happy path, missing fields, invalid types

#### Known Gaps
- validateOrder: concurrent validation not tested

### Canon Compliance
- **thin-handlers** (strong-opinion): ✓ COMPLIANT — extracted logic to service layer
- **validate-at-boundaries** (rule): ⚠ JUSTIFIED_DEVIATION — validation deferred to middleware layer for performance
- **naming-reveals-intent** (convention): ✓ COMPLIANT — descriptive names used

### Verification
- [x] New tests: 5 passing
- [x] Full test suite: passing
`;

describe("parseReviewArtifact", () => {
  it("extracts verdict from frontmatter", () => {
    const result = parseReviewArtifact(SAMPLE_REVIEW);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("WARNING");
  });

  it("extracts verdict from heading as fallback", () => {
    const noFrontmatter = SAMPLE_REVIEW.replace(/---\n[\s\S]*?\n---/, "");
    const result = parseReviewArtifact(noFrontmatter);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("WARNING");
  });

  it("parses violations table", () => {
    const result = parseReviewArtifact(SAMPLE_REVIEW)!;
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toEqual({
      principle_id: "thin-handlers",
      severity: "strong-opinion",
      file_path: "src/api/orders.ts",
    });
    expect(result.violations[1]).toEqual({
      principle_id: "validate-at-boundaries",
      severity: "rule",
      file_path: "src/api/orders.ts",
    });
  });

  it("parses honored list", () => {
    const result = parseReviewArtifact(SAMPLE_REVIEW)!;
    expect(result.honored).toEqual(["naming-reveals-intent", "errors-are-values"]);
  });

  it("parses and aggregates score table", () => {
    const result = parseReviewArtifact(SAMPLE_REVIEW)!;
    expect(result.score).toEqual({
      rules: { passed: 3, total: 4 },
      opinions: { passed: 3, total: 4 },
      conventions: { passed: 1, total: 1 },
    });
  });

  it("returns default score when no score table", () => {
    const noScore = SAMPLE_REVIEW.replace(/#### Score[\s\S]*?(?=###|$)/, "");
    const result = parseReviewArtifact(noScore)!;
    expect(result.score).toEqual({
      rules: { passed: 0, total: 0 },
      opinions: { passed: 0, total: 0 },
      conventions: { passed: 0, total: 0 },
    });
  });

  it("handles CLEAN review with no violations", () => {
    const clean = `---
verdict: "CLEAN"
---

## Canon Review — Verdict: CLEAN

### Principle Compliance

#### Honored
- **thin-handlers**: Handlers are thin
`;
    const result = parseReviewArtifact(clean)!;
    expect(result.verdict).toBe("CLEAN");
    expect(result.violations).toHaveLength(0);
    expect(result.honored).toEqual(["thin-handlers"]);
  });
});

describe("parseDecisionsFromSummary", () => {
  it("extracts JUSTIFIED_DEVIATION entries", () => {
    const decisions = parseDecisionsFromSummary(SAMPLE_SUMMARY, "test-SUMMARY.md");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].principle_id).toBe("validate-at-boundaries");
    expect(decisions[0].justification).toBe(
      "validation deferred to middleware layer for performance",
    );
    expect(decisions[0].file_path).toBe("test-SUMMARY.md");
    expect(decisions[0].decision_id).toMatch(/^dec_/);
  });

  it("returns empty for no deviations", () => {
    const noDeviations = `### Canon Compliance
- **thin-handlers** (strong-opinion): ✓ COMPLIANT — all good
`;
    expect(parseDecisionsFromSummary(noDeviations, "test.md")).toHaveLength(0);
  });

  it("returns empty when no compliance section", () => {
    expect(parseDecisionsFromSummary("no compliance here", "test.md")).toHaveLength(0);
  });
});

describe("executeEffects", () => {
  let tmpDir: string;
  let workspace: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-effects-test-"));
    workspace = join(tmpDir, "workspace");
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(workspace, "reviews"), { recursive: true });
    await mkdir(join(workspace, "plans", "test-task"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persist_review writes to reviews.jsonl", async () => {
    const reviewPath = join(workspace, "plans", "test-task", "REVIEW.md");
    await writeFile(reviewPath, SAMPLE_REVIEW);

    const stateDef: StateDefinition = {
      type: "single",
      effects: [{ type: "persist_review", artifact: "REVIEW.md" }],
    };

    const results = await executeEffects(
      stateDef,
      workspace,
      ["plans/test-task/REVIEW.md"],
      tmpDir,
    );

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("persist_review");
    expect(results[0].recorded).toBe(1);
    expect(results[0].errors).toHaveLength(0);

    // Verify JSONL was written
    const jsonl = await readFile(join(tmpDir, ".canon", "reviews.jsonl"), "utf-8");
    const entries = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe("WARNING");
    expect(entries[0].violations).toHaveLength(2);
    expect(entries[0].honored).toEqual(["naming-reveals-intent", "errors-are-values"]);
  });

  it("persist_decisions writes to decisions.jsonl", async () => {
    await writeFile(
      join(workspace, "plans", "test-task", "task-01-SUMMARY.md"),
      SAMPLE_SUMMARY,
    );

    const stateDef: StateDefinition = {
      type: "single",
      effects: [{ type: "persist_decisions" }],
    };

    const results = await executeEffects(stateDef, workspace, [], tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("persist_decisions");
    expect(results[0].recorded).toBe(1);

    const jsonl = await readFile(join(tmpDir, ".canon", "decisions.jsonl"), "utf-8");
    const entries = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].principle_id).toBe("validate-at-boundaries");
  });

  it("persist_patterns writes to patterns.jsonl", async () => {
    await writeFile(
      join(workspace, "plans", "test-task", "task-01-SUMMARY.md"),
      SAMPLE_SUMMARY,
    );

    const stateDef: StateDefinition = {
      type: "single",
      effects: [{ type: "persist_patterns" }],
    };

    const results = await executeEffects(stateDef, workspace, [], tmpDir);

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("persist_patterns");
    expect(results[0].recorded).toBe(1);

    const jsonl = await readFile(join(tmpDir, ".canon", "patterns.jsonl"), "utf-8");
    const entries = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].file_paths).toContain("src/api/orders.ts");
  });

  it("returns empty results when no effects defined", async () => {
    const stateDef: StateDefinition = { type: "single" };
    const results = await executeEffects(stateDef, workspace, [], tmpDir);
    expect(results).toHaveLength(0);
  });

  it("handles missing artifact gracefully", async () => {
    const stateDef: StateDefinition = {
      type: "single",
      effects: [{ type: "persist_review", artifact: "NONEXISTENT.md" }],
    };

    const results = await executeEffects(stateDef, workspace, [], tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].recorded).toBe(0);
    expect(results[0].errors.length).toBeGreaterThan(0);
  });

  it("runs multiple effects in sequence", async () => {
    const reviewPath = join(workspace, "plans", "test-task", "REVIEW.md");
    await writeFile(reviewPath, SAMPLE_REVIEW);
    await writeFile(
      join(workspace, "plans", "test-task", "task-01-SUMMARY.md"),
      SAMPLE_SUMMARY,
    );

    const stateDef: StateDefinition = {
      type: "single",
      effects: [
        { type: "persist_review", artifact: "REVIEW.md" },
        { type: "persist_decisions" },
        { type: "persist_patterns" },
      ],
    };

    const results = await executeEffects(
      stateDef,
      workspace,
      ["plans/test-task/REVIEW.md"],
      tmpDir,
    );

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.recorded > 0)).toBe(true);
  });
});
