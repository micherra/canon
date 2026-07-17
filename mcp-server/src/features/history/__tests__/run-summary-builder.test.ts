/**
 * Run Summary Builder Tests
 *
 * Tests extraction of structured data from workspace files for run summary generation.
 * Uses tmp directories to simulate workspace state. All assertions go through
 * buildRunSummary() and assert on the relevant field of the returned RunSummary.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunSummary } from "@platform/storage/archive/run-summary-builder.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

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

const DEFAULT_SLUG = "test-slug";
const DEFAULT_METADATA = {
  archivedAt: "2026-04-24T12:00:00.000Z",
  branch: "main",
  flow: "feature",
  task: "Test task",
  tier: "standard",
};

function callBuildRunSummary(workspacePath: string, slug = DEFAULT_SLUG) {
  return buildRunSummary({
    archiveId: "arch_test",
    metadata: DEFAULT_METADATA,
    slug,
    workspacePath,
  });
}

// ---- planner_context ----

describe("buildRunSummary — planner_context", () => {
  let tmpDir: string;
  let plansDir: string;
  const slug = DEFAULT_SLUG;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    plansDir = join(tmpDir, "plans");
    mkdirSync(join(plansDir, slug), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("returns null when no planner files exist", () => {
    const result = callBuildRunSummary(tmpDir);
    expect(result.planner_context).toBeNull();
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

    const result = callBuildRunSummary(tmpDir);
    expect(result.planner_context).not.toBeNull();
    expect(result.planner_context?.outcome).toBe("approve");
    expect(result.planner_context?.effort_estimate).toBe("medium");
    expect(result.planner_context?.value_estimate).toBe("high");
    expect(result.planner_context?.assumptions).toEqual([
      "The service already exists",
      "Tests are in place",
      "No breaking API changes needed",
    ]);
    expect(result.planner_context?.recommended_approach).toBe(
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

    const result = callBuildRunSummary(tmpDir);
    expect(result.planner_context).not.toBeNull();
    expect(result.planner_context?.runbook_steps).toHaveLength(3);
    expect(result.planner_context?.runbook_steps[0]).toMatchObject({
      agent: "researcher",
      step_id: "research",
    });
    expect(result.planner_context?.runbook_steps[1]).toMatchObject({
      agent: "implementor",
      step_id: "implement",
    });
    expect(result.planner_context?.runbook_steps[2]).toMatchObject({
      agent: "reviewer",
      step_id: "review",
    });
  });

  test("handles malformed planning-brief.md gracefully", () => {
    const malformed = `This has no structure at all
just some random text
without any markers
`;
    writeText(join(plansDir, slug), "planning-brief.md", malformed);

    // Should not throw — returns partial data
    const result = callBuildRunSummary(tmpDir);
    expect(result.planner_context).not.toBeNull();
    expect(result.planner_context?.outcome).toBe("");
    expect(result.planner_context?.effort_estimate).toBe("");
    expect(result.planner_context?.value_estimate).toBe("");
    expect(result.planner_context?.assumptions).toEqual([]);
  });

  test("returns partial data when only planning-brief.md exists", () => {
    const brief = `**Outcome**: approve\n**Effort estimate**: small\n**Value estimate**: medium\n`;
    writeText(join(plansDir, slug), "planning-brief.md", brief);

    const result = callBuildRunSummary(tmpDir);
    expect(result.planner_context).not.toBeNull();
    expect(result.planner_context?.outcome).toBe("approve");
    expect(result.planner_context?.runbook_steps).toEqual([]);
  });

  test("returns partial data when only runbook.md exists", () => {
    const runbook = `### Step 1: research\nagent: researcher\n`;
    writeText(join(plansDir, slug), "runbook.md", runbook);

    const result = callBuildRunSummary(tmpDir);
    expect(result.planner_context).not.toBeNull();
    expect(result.planner_context?.runbook_steps).toHaveLength(1);
    expect(result.planner_context?.outcome).toBe("");
  });
});

// ---- step_outcomes ----

describe("buildRunSummary — step_outcomes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  test("returns empty array when journal.json missing", () => {
    const result = callBuildRunSummary(tmpDir);
    expect(result.step_outcomes).toEqual([]);
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

    const result = callBuildRunSummary(tmpDir);
    expect(result.step_outcomes).toHaveLength(2);
    expect(result.step_outcomes[0].step_id).toBe("research");
    expect(result.step_outcomes[0].agent_type).toBe("researcher");
    expect(result.step_outcomes[0].status).toBe("completed");
    expect(result.step_outcomes[0].duration_ms).toBe(5 * 60 * 1000); // 5 minutes
    expect(result.step_outcomes[1].duration_ms).toBe(25 * 60 * 1000); // 25 minutes
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

    const result = callBuildRunSummary(tmpDir);
    expect(result.step_outcomes).toHaveLength(2);
    expect(result.step_outcomes[0].duration_ms).toBeNull();
    expect(result.step_outcomes[1].started_at).toBeNull();
    expect(result.step_outcomes[1].completed_at).toBeNull();
    expect(result.step_outcomes[1].duration_ms).toBeNull();
  });

  test("handles malformed journal.json gracefully", () => {
    writeFileSync(join(tmpDir, "journal.json"), "{ invalid json }", "utf-8");
    const result = callBuildRunSummary(tmpDir);
    expect(result.step_outcomes).toEqual([]);
  });
});

// ---- review_results ----

describe("buildRunSummary — review_results", () => {
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
    const result = callBuildRunSummary(tmpDir);
    expect(result.review_results).toEqual([]);
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

| Principle | Severity | Location | Confidence |
|-----------|----------|----------|------------|
| errors-are-values | strong-opinion | \`src/foo.ts\` | HIGH |

#### Honored

- validate-at-trust-boundaries
- fail-closed-by-default
`;
    writeText(reviewsDir, "REVIEW.md", reviewContent);

    const result = callBuildRunSummary(tmpDir);
    expect(result.review_results).toHaveLength(1);
    expect(result.review_results[0].verdict).toBe("approved");
    expect(result.review_results[0].files_reviewed).toBe(5);
    expect(result.review_results[0].principles_checked).toBe(12);
    expect(result.review_results[0].violations).toHaveLength(1);
    expect(result.review_results[0].violations[0].principle_id).toBe("errors-are-values");
    expect(result.review_results[0].honored).toContain("validate-at-trust-boundaries");
    expect(result.review_results[0].honored).toContain("fail-closed-by-default");
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

    const result = callBuildRunSummary(tmpDir);
    expect(result.review_results).toHaveLength(1);
    expect(result.review_results[0].violations).toEqual([]);
    expect(result.review_results[0].honored).toContain("bounded-context-boundaries");
  });

  test("returns empty array for non-.md files in reviews/", () => {
    mkdirSync(reviewsDir, { recursive: true });
    writeText(reviewsDir, "notes.txt", "some notes");
    const result = callBuildRunSummary(tmpDir);
    expect(result.review_results).toEqual([]);
  });

  test("handles malformed frontmatter gracefully", () => {
    mkdirSync(reviewsDir, { recursive: true });
    writeText(reviewsDir, "REVIEW.md", "no frontmatter here");
    const result = callBuildRunSummary(tmpDir);
    // Should not throw — returns entry with defaults
    expect(Array.isArray(result.review_results)).toBe(true);
  });
});

// ---- artifact_inventory ----

describe("buildRunSummary — artifact_inventory", () => {
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

    const reviewsDir = join(tmpDir, "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeText(reviewsDir, "REVIEW.md", "review content");

    const result = callBuildRunSummary(tmpDir);
    const inventory = result.artifact_inventory;
    const plansEntry = inventory.directories.find((d) => d.name === "plans");
    const reviewsEntry = inventory.directories.find((d) => d.name === "reviews");

    expect(plansEntry).toBeDefined();
    expect(plansEntry?.file_count).toBe(2);
    expect(reviewsEntry).toBeDefined();
    expect(reviewsEntry?.file_count).toBe(1);
  });

  test("counts top-level files separately", () => {
    writeText(tmpDir, "journal.json", "{}");
    writeText(tmpDir, "context.md", "context");

    const result = callBuildRunSummary(tmpDir);
    const inventory = result.artifact_inventory;
    expect(inventory.files).toContain("journal.json");
    expect(inventory.files).toContain("context.md");
  });

  test("total_files is sum of all files", () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeText(plansDir, "PLAN.md", "content");
    writeText(tmpDir, "journal.json", "{}");

    const result = callBuildRunSummary(tmpDir);
    expect(result.artifact_inventory.total_files).toBe(2);
  });

  test("returns empty inventory when workspace is empty", () => {
    const result = callBuildRunSummary(tmpDir);
    const inventory = result.artifact_inventory;
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
    expect(result.artifact_inventory.total_files).toBe(0);
    // run_metadata timing should default to null when not available
    expect(result.run_metadata.started_at).toBeNull();
    expect(result.run_metadata.completed_at).toBeNull();
    expect(result.run_metadata.total_duration_ms).toBeNull();
  });

  test("decision_summaries is always an empty array for version: 1 backward compat", () => {
    const result = buildRunSummary({
      archiveId: "arch_compat_001",
      metadata: {
        archivedAt: "2026-05-25T12:00:00.000Z",
        branch: "main",
        flow: "fast-path",
        task: "Compat test",
        tier: "simple",
      },
      slug: "compat-slug",
      workspacePath: tmpDir,
    });

    expect(result.decision_summaries).toEqual([]);
  });
});
