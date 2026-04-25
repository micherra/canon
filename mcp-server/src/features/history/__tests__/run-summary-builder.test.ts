/**
 * Run Summary Builder Tests
 *
 * Tests extraction of structured data from workspace files for run summary generation.
 * Uses tmp directories to simulate workspace state. All extraction functions are
 * pure in terms of side effects — they read files and return data.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildArtifactInventory,
  buildRunSummary,
  extractDecisionSummaries,
  extractPlannerContext,
  extractReviewResults,
  extractStepOutcomes,
} from "../services/run-summary-builder.ts";

// ---- Helpers ----

function makeTmpDir(): string {
  const dir = join(tmpdir(), `run-summary-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir: string, filename: string, data: unknown): void {
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2), "utf-8");
}

function writeText(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, "utf-8");
}

// ---- extractPlannerContext ----

describe("extractPlannerContext", () => {
  let tmpDir: string;
  let plansDir: string;
  const slug = "test-slug";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    plansDir = join(tmpDir, "plans");
    mkdirSync(join(plansDir, slug), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("returns null when no planner files exist", () => {
    const result = extractPlannerContext(plansDir, slug);
    expect(result).toBeNull();
  });

  test("extracts outcome, effort, value, assumptions from planning-brief.md", () => {
    const brief = `---
title: Planning Brief
---

**Outcome**: approve

**Effort estimate**: medium

**Value estimate**: high

## ASSUMPTIONS

1. The service already exists
2. Tests are in place
3. No breaking API changes needed

## Recommended Approach

Use the existing pattern from the orchestration module.
`;
    writeText(join(plansDir, slug), "planning-brief.md", brief);

    const result = extractPlannerContext(plansDir, slug);
    expect(result).not.toBeNull();
    expect(result?.outcome).toBe("approve");
    expect(result?.effort_estimate).toBe("medium");
    expect(result?.value_estimate).toBe("high");
    expect(result?.assumptions).toEqual([
      "The service already exists",
      "Tests are in place",
      "No breaking API changes needed",
    ]);
    expect(result?.recommended_approach).toBe(
      "Use the existing pattern from the orchestration module.",
    );
  });

  test("extracts steps from runbook.md", () => {
    const runbook = `---
flow: feature
tier: standard
---

## Build Plan

### Step 1: research
agent: researcher
hitl: false

### Step 2: implement
agent: implementor
hitl: true

### Step 3: review
agent: reviewer
`;
    writeText(join(plansDir, slug), "runbook.md", runbook);

    const result = extractPlannerContext(plansDir, slug);
    expect(result).not.toBeNull();
    expect(result?.runbook_steps).toHaveLength(3);
    expect(result?.runbook_steps[0]).toMatchObject({ agent: "researcher", step_id: "research" });
    expect(result?.runbook_steps[1]).toMatchObject({ agent: "implementor", step_id: "implement" });
    expect(result?.runbook_steps[2]).toMatchObject({ agent: "reviewer", step_id: "review" });
  });

  test("handles malformed planning-brief.md gracefully", () => {
    const malformed = `This has no structure at all
just some random text
without any markers
`;
    writeText(join(plansDir, slug), "planning-brief.md", malformed);

    // Should not throw — returns partial data
    const result = extractPlannerContext(plansDir, slug);
    expect(result).not.toBeNull();
    expect(result?.outcome).toBe("");
    expect(result?.effort_estimate).toBe("");
    expect(result?.value_estimate).toBe("");
    expect(result?.assumptions).toEqual([]);
  });

  test("returns partial data when only planning-brief.md exists", () => {
    const brief = `**Outcome**: approve\n**Effort estimate**: small\n**Value estimate**: medium\n`;
    writeText(join(plansDir, slug), "planning-brief.md", brief);

    const result = extractPlannerContext(plansDir, slug);
    expect(result).not.toBeNull();
    expect(result?.outcome).toBe("approve");
    expect(result?.runbook_steps).toEqual([]);
  });

  test("returns partial data when only runbook.md exists", () => {
    const runbook = `### Step 1: research\nagent: researcher\n`;
    writeText(join(plansDir, slug), "runbook.md", runbook);

    const result = extractPlannerContext(plansDir, slug);
    expect(result).not.toBeNull();
    expect(result?.runbook_steps).toHaveLength(1);
    expect(result?.outcome).toBe("");
  });
});

// ---- extractStepOutcomes ----

describe("extractStepOutcomes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("returns empty array when journal.json missing", () => {
    const result = extractStepOutcomes(tmpDir);
    expect(result).toEqual([]);
  });

  test("extracts step data with correct duration calculations", () => {
    const journal = {
      steps: [
        {
          agent_type: "researcher",
          artifacts_expected: ["research/synthesis.md"],
          completed_at: "2026-04-24T10:05:00.000Z",
          started_at: "2026-04-24T10:00:00.000Z",
          status: "completed",
          step_id: "research",
        },
        {
          agent_type: "implementor",
          artifacts_expected: ["plans/slug/SUMMARY.md"],
          completed_at: "2026-04-24T10:30:00.000Z",
          started_at: "2026-04-24T10:05:00.000Z",
          status: "completed",
          step_id: "implement",
        },
      ],
    };
    writeJson(tmpDir, "journal.json", journal);

    const result = extractStepOutcomes(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].step_id).toBe("research");
    expect(result[0].agent_type).toBe("researcher");
    expect(result[0].status).toBe("completed");
    expect(result[0].duration_ms).toBe(5 * 60 * 1000); // 5 minutes
    expect(result[1].duration_ms).toBe(25 * 60 * 1000); // 25 minutes
  });

  test("handles incomplete journal entries (missing timestamps)", () => {
    const journal = {
      steps: [
        {
          agent_type: "researcher",
          artifacts_expected: [],
          completed_at: null,
          started_at: "2026-04-24T10:00:00.000Z",
          status: "started",
          step_id: "research",
        },
        {
          agent_type: "implementor",
          artifacts_expected: [],
          status: "pending",
          step_id: "implement",
        },
      ],
    };
    writeJson(tmpDir, "journal.json", journal);

    const result = extractStepOutcomes(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].duration_ms).toBeNull();
    expect(result[1].started_at).toBeNull();
    expect(result[1].completed_at).toBeNull();
    expect(result[1].duration_ms).toBeNull();
  });

  test("handles malformed journal.json gracefully", () => {
    writeFileSync(join(tmpDir, "journal.json"), "{ invalid json }", "utf-8");
    const result = extractStepOutcomes(tmpDir);
    expect(result).toEqual([]);
  });
});

// ---- extractReviewResults ----

describe("extractReviewResults", () => {
  let tmpDir: string;
  let reviewsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    reviewsDir = join(tmpDir, "reviews");
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("returns empty array when reviews/ missing", () => {
    const result = extractReviewResults(tmpDir);
    expect(result).toEqual([]);
  });

  test("extracts verdict, violations, honored from REVIEW.md", () => {
    mkdirSync(reviewsDir, { recursive: true });
    const reviewContent = `---
verdict: approved
files-reviewed: 5
principles-checked: 12
---

## Review Results

#### Violations

- **principle-id**: errors-are-values — **severity**: strong-opinion — **file**: src/foo.ts — Missing error handling

#### Honored

- validate-at-trust-boundaries
- fail-closed-by-default
`;
    writeText(reviewsDir, "REVIEW.md", reviewContent);

    const result = extractReviewResults(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].verdict).toBe("approved");
    expect(result[0].files_reviewed).toBe(5);
    expect(result[0].principles_checked).toBe(12);
    expect(result[0].violations).toHaveLength(1);
    expect(result[0].violations[0].principle_id).toBe("errors-are-values");
    expect(result[0].honored).toContain("validate-at-trust-boundaries");
    expect(result[0].honored).toContain("fail-closed-by-default");
  });

  test("handles 'No violations found.' as empty violations array", () => {
    mkdirSync(reviewsDir, { recursive: true });
    const reviewContent = `---
verdict: approved
files-reviewed: 3
principles-checked: 8
---

## Review Results

#### Violations

No violations found.

#### Honored

- bounded-context-boundaries
`;
    writeText(reviewsDir, "REVIEW.md", reviewContent);

    const result = extractReviewResults(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].violations).toEqual([]);
    expect(result[0].honored).toContain("bounded-context-boundaries");
  });

  test("returns empty array for non-.md files in reviews/", () => {
    mkdirSync(reviewsDir, { recursive: true });
    writeText(reviewsDir, "notes.txt", "some notes");
    const result = extractReviewResults(tmpDir);
    expect(result).toEqual([]);
  });

  test("handles malformed frontmatter gracefully", () => {
    mkdirSync(reviewsDir, { recursive: true });
    writeText(reviewsDir, "REVIEW.md", "no frontmatter here");
    const result = extractReviewResults(tmpDir);
    // Should not throw — returns entry with defaults
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---- extractDecisionSummaries ----

describe("extractDecisionSummaries", () => {
  let tmpDir: string;
  let decisionsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    decisionsDir = join(tmpDir, "decisions");
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("returns empty array when decisions/ missing", () => {
    const result = extractDecisionSummaries(tmpDir);
    expect(result).toEqual([]);
  });

  test("extracts decision-id, title, chosen option, rationale snippet", () => {
    mkdirSync(decisionsDir, { recursive: true });
    const decisionContent = `---
decision-id: history-01
title: Archive storage strategy
---

## Options

### Option A: File-based storage
### Option B: Database-only

### Chosen: file-based

### Rationale

File-based storage keeps archives as human-readable directories with no extra tooling required to inspect. The manifest is in drift.db for queryability.
`;
    writeText(decisionsDir, "history-01.md", decisionContent);

    const result = extractDecisionSummaries(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].decision_id).toBe("history-01");
    expect(result[0].title).toBe("Archive storage strategy");
    expect(result[0].chosen_option).toBe("file-based");
    expect(result[0].rationale_snippet.length).toBeGreaterThan(0);
    expect(result[0].rationale_snippet).toContain("File-based storage");
  });

  test("truncates rationale to ~200 chars", () => {
    mkdirSync(decisionsDir, { recursive: true });
    const longRationale = "A".repeat(500);
    const decisionContent = `---
decision-id: long-01
title: Long rationale decision
---

### Chosen: option-a

### Rationale

${longRationale}
`;
    writeText(decisionsDir, "long-01.md", decisionContent);

    const result = extractDecisionSummaries(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].rationale_snippet.length).toBeLessThanOrEqual(203); // ~200 + possible "..."
  });

  test("handles malformed decision files gracefully", () => {
    mkdirSync(decisionsDir, { recursive: true });
    writeText(decisionsDir, "bad.md", "no frontmatter at all\njust text");
    // Should not throw
    const result = extractDecisionSummaries(tmpDir);
    expect(Array.isArray(result)).toBe(true);
  });

  test("ignores non-.md files", () => {
    mkdirSync(decisionsDir, { recursive: true });
    writeText(decisionsDir, "notes.txt", "some notes");
    const result = extractDecisionSummaries(tmpDir);
    expect(result).toEqual([]);
  });
});

// ---- buildArtifactInventory ----

describe("buildArtifactInventory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("counts files per directory correctly", () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeText(plansDir, "PLAN.md", "plan content");
    writeText(plansDir, "SUMMARY.md", "summary content");

    const decisionsDir = join(tmpDir, "decisions");
    mkdirSync(decisionsDir, { recursive: true });
    writeText(decisionsDir, "decision-01.md", "decision");

    const inventory = buildArtifactInventory(tmpDir);
    const plansEntry = inventory.directories.find((d) => d.name === "plans");
    const decisionsEntry = inventory.directories.find((d) => d.name === "decisions");

    expect(plansEntry).toBeDefined();
    expect(plansEntry?.file_count).toBe(2);
    expect(decisionsEntry).toBeDefined();
    expect(decisionsEntry?.file_count).toBe(1);
  });

  test("counts top-level files separately", () => {
    writeText(tmpDir, "journal.json", "{}");
    writeText(tmpDir, "context.md", "context");

    const inventory = buildArtifactInventory(tmpDir);
    expect(inventory.files).toContain("journal.json");
    expect(inventory.files).toContain("context.md");
  });

  test("total_files is sum of all files", () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeText(plansDir, "PLAN.md", "content");
    writeText(tmpDir, "journal.json", "{}");

    const inventory = buildArtifactInventory(tmpDir);
    expect(inventory.total_files).toBe(2);
  });

  test("returns empty inventory when workspace is empty", () => {
    const inventory = buildArtifactInventory(tmpDir);
    expect(inventory.directories).toEqual([]);
    expect(inventory.files).toEqual([]);
    expect(inventory.total_files).toBe(0);
  });
});

// ---- buildRunSummary ----

describe("buildRunSummary", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("produces complete RunSummary with all sections populated", () => {
    const slug = "test-slug";
    const plansDir = join(tmpDir, "plans");
    mkdirSync(join(plansDir, slug), { recursive: true });
    writeText(
      join(plansDir, slug),
      "planning-brief.md",
      "**Outcome**: approve\n**Effort estimate**: small\n**Value estimate**: high\n",
    );

    const decisionsDir = join(tmpDir, "decisions");
    mkdirSync(decisionsDir, { recursive: true });
    writeText(
      decisionsDir,
      "d01.md",
      "---\ndecision-id: d01\ntitle: A decision\n---\n### Chosen: option-a\n### Rationale\nBecause it works.\n",
    );

    const journal = {
      steps: [
        {
          agent_type: "researcher",
          artifacts_expected: [],
          completed_at: "2026-04-24T10:10:00.000Z",
          started_at: "2026-04-24T10:00:00.000Z",
          status: "completed",
          step_id: "research",
        },
      ],
    };
    writeJson(tmpDir, "journal.json", journal);

    const result = buildRunSummary({
      archiveId: "arch_test_001",
      metadata: {
        archivedAt: "2026-04-24T12:00:00.000Z",
        branch: "main",
        flow: "feature",
        task: "Test task",
        tier: "standard",
      },
      slug,
      workspacePath: tmpDir,
    });

    expect(result.version).toBe(1);
    expect(result.archive_id).toBe("arch_test_001");
    expect(result.run_metadata.branch).toBe("main");
    expect(result.run_metadata.slug).toBe(slug);
    expect(result.run_metadata.flow).toBe("feature");
    expect(result.run_metadata.archived_at).toBe("2026-04-24T12:00:00.000Z");
    expect(result.planner_context).not.toBeNull();
    expect(result.step_outcomes).toHaveLength(1);
    expect(result.decision_summaries).toHaveLength(1);
    expect(result.artifact_inventory).toBeDefined();
  });

  test("produces valid RunSummary when workspace is mostly empty", () => {
    const result = buildRunSummary({
      archiveId: "arch_empty_001",
      metadata: {
        archivedAt: "2026-04-24T12:00:00.000Z",
        branch: "main",
        flow: "fast-path",
        task: "Minimal task",
        tier: "simple",
      },
      slug: "empty-slug",
      workspacePath: tmpDir,
    });

    expect(result.version).toBe(1);
    expect(result.archive_id).toBe("arch_empty_001");
    expect(result.planner_context).toBeNull();
    expect(result.step_outcomes).toEqual([]);
    expect(result.review_results).toEqual([]);
    expect(result.decision_summaries).toEqual([]);
    expect(result.artifact_inventory.total_files).toBe(0);
    // run_metadata timing should default to null when not available
    expect(result.run_metadata.started_at).toBeNull();
    expect(result.run_metadata.completed_at).toBeNull();
    expect(result.run_metadata.total_duration_ms).toBeNull();
  });
});
