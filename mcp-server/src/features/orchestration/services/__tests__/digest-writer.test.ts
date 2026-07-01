/**
 * digest-writer — unit tests for the build digest writer service.
 *
 * Tests pure functions (resolveAutoMemoryDir, extractDigestData, formatDigestMarkdown,
 * formatMemoryIndexEntry) and integration (tryWriteBuildDigest success + failure cases).
 *
 * Mock strategy:
 *  - Mock `homedir` to control where resolveAutoMemoryDir looks
 *  - Mock `../../../app/server-state.ts` to control projectDir
 *  - Mock getExecutionStore for session data
 *  - Use real temp dirs for filesystem tests
 */

import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ---- Module mocks (must be before imports) ----

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: vi.fn(() => "/mock-home"),
  };
});

vi.mock("@app/server-state.ts", () => ({
  projectDir: "/Users/mock/project",
}));

vi.mock("@domains/workspaces/execution-store-cache.ts", () => ({
  getExecutionStore: vi.fn(() => ({
    getSession: vi.fn(() => ({
      branch: "canon/my-slug",
      created: "2026-01-15T10:00:00.000Z",
      flow: "feature",
      sanitized: "my-slug",
      slug: "my-slug",
      status: "active" as const,
      task: "Build something",
    })),
  })),
}));

// Import after mocks
import { homedir } from "node:os";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import {
  extractDigestData,
  formatDigestMarkdown,
  formatMemoryIndexEntry,
  resolveAutoMemoryDir,
  tryWriteBuildDigest,
} from "../digest-writer.ts";

// ---- Test fixtures ----

const FIXTURE_JOURNAL = JSON.stringify({
  steps: [
    {
      agent_type: "engineer",
      artifacts_expected: [],
      completed_at: "2026-01-15T10:30:00.000Z",
      outcome: { fix_iterations: 2, review_verdict: "CLEAN" },
      started_at: "2026-01-15T10:00:00.000Z",
      status: "completed",
      step_id: "implement",
    },
    {
      agent_type: "reviewer",
      artifacts_expected: [],
      completed_at: "2026-01-15T10:45:00.000Z",
      outcome: { review_verdict: "CLEAN" },
      started_at: "2026-01-15T10:31:00.000Z",
      status: "completed",
      step_id: "review",
    },
  ],
  version: 1,
  workspace: "/tmp/workspace",
});

const FIXTURE_PLANNING_BRIEF = `---
status: approved
---

## Build: my-slug

**Outcome**: Add new API endpoint
**Effort estimate**: 2 hours
**Value estimate**: High
`;

const FIXTURE_REVIEW = `---
verdict: CLEAN
files-reviewed: 3
principles-checked: 8
---

#### Violations

No violations found.

#### Honored

- deep-modules
- functions-do-one-thing
`;

const FIXTURE_REVIEW_WITH_VIOLATIONS = `---
verdict: BLOCKING
files-reviewed: 2
principles-checked: 5
---

#### Violations

- **principle-id**: deep-modules — **severity**: rule — **file**: src/foo.ts — Violation message
- **principle-id**: no-magic-numbers — **severity**: convention — **file**: src/bar.ts — Another violation

#### Honored

- information-hiding
`;

const FIXTURE_SUMMARY_WITH_DECISIONS = `### Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| d1 | Used a pure extractor | Keeps the digest field never-throw and easy to test |
`;

// ---- resolveAutoMemoryDir ----

describe("resolveAutoMemoryDir", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "canon-auto-memory-"));
    vi.mocked(homedir).mockReturnValue(tempHome);
  });

  afterEach(async () => {
    await rm(tempHome, { force: true, recursive: true });
  });

  test("converts /Users/michelle/Documents/canon to -Users-michelle-Documents-canon", async () => {
    const memDir = join(
      tempHome,
      ".claude",
      "projects",
      "-Users-michelle-Documents-canon",
      "memory",
    );
    mkdirSync(memDir, { recursive: true });

    const result = resolveAutoMemoryDir("/Users/michelle/Documents/canon");
    expect(result).toBe(memDir);
  });

  test("returns null for empty string input", () => {
    const result = resolveAutoMemoryDir("");
    expect(result).toBeNull();
  });

  test("returns null when directory does not exist", () => {
    const result = resolveAutoMemoryDir("/Users/somebody/nonexistent-project");
    expect(result).toBeNull();
  });

  test("correctly converts path with leading slash", async () => {
    const memDir = join(tempHome, ".claude", "projects", "-a-b-c", "memory");
    mkdirSync(memDir, { recursive: true });

    const result = resolveAutoMemoryDir("/a/b/c");
    expect(result).toBe(memDir);
  });
});

// ---- extractDigestData ----

describe("extractDigestData", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "canon-digest-ws-"));

    // Default: session returns slug = "my-slug"
    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn(() => ({
        branch: "canon/my-slug",
        created: "2026-01-15T10:00:00.000Z",
        flow: "feature",
        sanitized: "my-slug",
        slug: "my-slug",
        status: "active" as const,
        task: "Build something",
      })),
    } as unknown as import("@domains/workspaces/execution-store.ts").ExecutionStore);
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  test("extracts all fields from a workspace with journal, planning-brief, and REVIEW.md", async () => {
    // Write journal
    await writeFile(join(workspace, "journal.json"), FIXTURE_JOURNAL, "utf-8");

    // Write planning brief
    const plansDir = join(workspace, "plans", "my-slug");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "planning-brief.md"), FIXTURE_PLANNING_BRIEF, "utf-8");

    // Write review
    const reviewsDir = join(workspace, "reviews");
    await mkdir(reviewsDir, { recursive: true });
    await writeFile(join(reviewsDir, "REVIEW.md"), FIXTURE_REVIEW, "utf-8");

    const data = extractDigestData(workspace);

    expect(data.slug).toBe("my-slug");
    expect(data.branch).toBe("canon/my-slug");
    expect(data.totalSteps).toBe(2);
    expect(data.stepsCompleted).toBe(2);
    expect(data.stepsSkipped).toBe(0);
    expect(data.fixIterations).toBe(2);
    expect(data.reviewVerdict).toBe("CLEAN");
    expect(data.violationCount).toBe(0);
    expect(data.effortEstimate).toBe("2 hours");
    expect(data.valueEstimate).toBe("High");
    expect(data.outcome).toBe("Add new API endpoint");
    expect(data.totalDurationMs).not.toBeNull();
    // Duration: 10:45 - 10:00 = 45 minutes = 2700000ms
    expect(data.totalDurationMs).toBe(2700000);
  });

  test("sums violation counts across multiple review files", async () => {
    await writeFile(join(workspace, "journal.json"), FIXTURE_JOURNAL, "utf-8");

    const reviewsDir = join(workspace, "reviews");
    await mkdir(reviewsDir, { recursive: true });
    await writeFile(join(reviewsDir, "REVIEW-1.md"), FIXTURE_REVIEW, "utf-8");
    await writeFile(join(reviewsDir, "REVIEW-2.md"), FIXTURE_REVIEW_WITH_VIOLATIONS, "utf-8");

    const data = extractDigestData(workspace);

    // REVIEW.md has 0 violations, REVIEW-2.md has 2 violations
    expect(data.violationCount).toBe(2);
  });

  test("returns defaults when workspace has only journal.json (no planning brief, no reviews)", async () => {
    await writeFile(join(workspace, "journal.json"), FIXTURE_JOURNAL, "utf-8");

    const data = extractDigestData(workspace);

    expect(data.slug).toBe("my-slug");
    expect(data.effortEstimate).toBe("");
    expect(data.valueEstimate).toBe("");
    expect(data.outcome).toBe("");
    expect(data.violationCount).toBe(0);
  });

  test("returns defaults when journal.json has no steps", async () => {
    const emptyJournal = JSON.stringify({ steps: [], version: 1, workspace });
    await writeFile(join(workspace, "journal.json"), emptyJournal, "utf-8");

    const data = extractDigestData(workspace);

    expect(data.totalSteps).toBe(0);
    expect(data.stepsCompleted).toBe(0);
    expect(data.stepsSkipped).toBe(0);
    expect(data.fixIterations).toBe(0);
    expect(data.reviewVerdict).toBeNull();
    expect(data.totalDurationMs).toBeNull();
  });

  test("falls back to basename(workspace) as slug when session is null", async () => {
    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn(() => null),
    } as unknown as import("@domains/workspaces/execution-store.ts").ExecutionStore);

    const emptyJournal = JSON.stringify({ steps: [], version: 1, workspace });
    await writeFile(join(workspace, "journal.json"), emptyJournal, "utf-8");

    const data = extractDigestData(workspace);

    // slug should be derived from workspace basename
    expect(data.slug).toBeTruthy();
    expect(typeof data.slug).toBe("string");
  });

  test("populates notable_resolution from a *-SUMMARY.md Decisions table", async () => {
    await writeFile(join(workspace, "journal.json"), FIXTURE_JOURNAL, "utf-8");

    const plansDir = join(workspace, "plans", "my-slug");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "task-01-SUMMARY.md"), FIXTURE_SUMMARY_WITH_DECISIONS, "utf-8");

    const data = extractDigestData(workspace);

    expect(data.notableResolution).toBe("Keeps the digest field never-throw and easy to test");
  });

  test("notable_resolution is empty string when no SUMMARY or DESIGN present", async () => {
    await writeFile(join(workspace, "journal.json"), FIXTURE_JOURNAL, "utf-8");

    const data = extractDigestData(workspace);

    expect(data.notableResolution).toBe("");
  });
});

// ---- formatDigestMarkdown ----

describe("formatDigestMarkdown", () => {
  const baseData = {
    branch: "canon/test-slug",
    date: "2026-01-15",
    effortEstimate: "2 hours",
    fixIterations: 1,
    notableResolution: "",
    outcome: "Add feature",
    reviewVerdict: "CLEAN",
    slug: "test-slug",
    stepsCompleted: 3,
    stepsSkipped: 0,
    totalDurationMs: 2700000, // 45 minutes
    totalSteps: 3,
    valueEstimate: "High",
    violationCount: 0,
  };

  test("output contains YAML frontmatter with correct name, description, metadata.type", () => {
    const md = formatDigestMarkdown(baseData);

    expect(md).toContain("---");
    expect(md).toContain("name: build-digest-2026-01-15-test-slug");
    expect(md).toContain("description:");
    expect(md).toContain("test-slug");
    expect(md).toContain("metadata:");
    expect(md).toContain("type: project");
  });

  test("output contains all digest fields in expected markdown format", () => {
    const md = formatDigestMarkdown(baseData);

    expect(md).toContain("## Build: test-slug");
    expect(md).toContain("**Branch**: canon/test-slug");
    expect(md).toContain("**Date**: 2026-01-15");
    expect(md).toContain("2 hours");
    expect(md).toContain("High");
    expect(md).toContain("Add feature");
    expect(md).toContain("CLEAN");
    expect(md).toContain("3");
    expect(md).toContain("1"); // fix iterations
  });

  test("handles null duration gracefully", () => {
    const data = { ...baseData, totalDurationMs: null };
    const md = formatDigestMarkdown(data);

    expect(md).toContain("unknown");
  });

  test("formats duration as Xm Ys for sub-hour durations", () => {
    const data = { ...baseData, totalDurationMs: 150000 }; // 2m 30s
    const md = formatDigestMarkdown(data);

    expect(md).toContain("2m 30s");
  });

  test("formats duration as Xh Ym for hour-plus durations", () => {
    const data = { ...baseData, totalDurationMs: 3900000 }; // 1h 5m
    const md = formatDigestMarkdown(data);

    expect(md).toContain("1h 5m");
  });

  test("emits ### Notable Resolution section with the frozen line when notable_resolution is populated", () => {
    const data = { ...baseData, notableResolution: "Used a pure extractor for the digest field" };
    const md = formatDigestMarkdown(data);

    expect(md).toContain("### Notable Resolution");
    const matches = md.match(/\*\*Notable resolution\*\*: /g);
    expect(matches?.length).toBe(1);
    expect(md).toContain("**Notable resolution**: Used a pure extractor for the digest field");
  });

  test("omits the ### Notable Resolution section entirely when notable_resolution is empty", () => {
    const data = { ...baseData, notableResolution: "" };
    const md = formatDigestMarkdown(data);

    expect(md).not.toContain("### Notable Resolution");
    expect(md).not.toContain("**Notable resolution**:");
  });
});

// ---- formatMemoryIndexEntry ----

describe("formatMemoryIndexEntry", () => {
  const baseData = {
    branch: "canon/test-slug",
    date: "2026-01-15",
    effortEstimate: "2 hours",
    fixIterations: 0,
    notableResolution: "",
    outcome: "Add feature",
    reviewVerdict: "CLEAN",
    slug: "test-slug",
    stepsCompleted: 3,
    stepsSkipped: 0,
    totalDurationMs: 1800000, // 30m
    totalSteps: 3,
    valueEstimate: "High",
    violationCount: 0,
  };

  test("output is under 150 characters", () => {
    const entry = formatMemoryIndexEntry(baseData);
    expect(entry.length).toBeLessThanOrEqual(150);
  });

  test("contains the file link and summary", () => {
    const entry = formatMemoryIndexEntry(baseData);
    expect(entry).toContain("build-digest-2026-01-15-test-slug.md");
    expect(entry).toContain("test-slug");
    expect(entry).toContain("CLEAN");
  });

  test("starts with a markdown list item", () => {
    const entry = formatMemoryIndexEntry(baseData);
    expect(entry.startsWith("- ")).toBe(true);
  });

  test("handles null duration without error", () => {
    const data = { ...baseData, totalDurationMs: null };
    const entry = formatMemoryIndexEntry(data);
    expect(entry.length).toBeLessThanOrEqual(150);
    expect(entry.startsWith("- ")).toBe(true);
  });

  test("handles null reviewVerdict without error", () => {
    const data = { ...baseData, reviewVerdict: null };
    const entry = formatMemoryIndexEntry(data);
    expect(entry.length).toBeLessThanOrEqual(150);
  });

  test("truncation preserves the markdown link when slug causes total to exceed 150 chars", () => {
    // Use a slug long enough that link + summary exceeds 150 but the link alone is <= 150.
    // A 20-char slug: link is ~88 chars, summary adds ~50 chars → total ~138, still fits.
    // Use 30-char slug: link is ~108 chars, summary adds ~55 chars → total ~163, triggers truncation.
    const longSlug = "a".repeat(30);
    const longData: typeof baseData = {
      ...baseData,
      reviewVerdict: "CLEAN",
      slug: longSlug,
      totalDurationMs: 60000,
    };
    const entry = formatMemoryIndexEntry(longData);
    expect(entry.length).toBeLessThanOrEqual(150);
    // The link portion must be intact (the link itself is well under 150 chars)
    const fileName = `build-digest-${longData.date}-${longSlug}.md`;
    const link = `- [${fileName}](${fileName})`;
    expect(link.length).toBeLessThan(150); // assert our test assumption
    expect(entry.startsWith(link)).toBe(true);
    // Entry ends with "..." when truncated
    expect(entry.endsWith("...")).toBe(true);
  });
});

// ---- tryWriteBuildDigest ----

describe("tryWriteBuildDigest", () => {
  let workspace: string;
  let memoryDir: string;
  let tempHome: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "canon-digest-ws-"));
    tempHome = await mkdtemp(join(tmpdir(), "canon-digest-home-"));

    // Set up memory directory matching the mock projectDir "/Users/mock/project"
    memoryDir = join(tempHome, ".claude", "projects", "-Users-mock-project", "memory");
    mkdirSync(memoryDir, { recursive: true });

    // homedir returns our temp home
    vi.mocked(homedir).mockReturnValue(tempHome);

    // Session returns slug "my-slug"
    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn(() => ({
        branch: "canon/my-slug",
        created: "2026-01-15T10:00:00.000Z",
        flow: "feature",
        sanitized: "my-slug",
        slug: "my-slug",
        status: "active" as const,
        task: "Build something",
      })),
    } as unknown as import("@domains/workspaces/execution-store.ts").ExecutionStore);
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
    await rm(tempHome, { force: true, recursive: true });
  });

  test("success case: creates digest file and appends to MEMORY.md", async () => {
    // Set up workspace with journal and plans
    await writeFile(join(workspace, "journal.json"), FIXTURE_JOURNAL, "utf-8");
    const plansDir = join(workspace, "plans", "my-slug");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "planning-brief.md"), FIXTURE_PLANNING_BRIEF, "utf-8");

    const result = await tryWriteBuildDigest(workspace, "/Users/mock/project");

    expect(result).toBe(true);

    // Digest file should exist
    const files = await import("node:fs/promises").then((fs) => fs.readdir(memoryDir));
    const digestFile = files.find((f) => f.startsWith("build-digest-"));
    expect(digestFile).toBeTruthy();

    // MEMORY.md should have been created with an entry
    const memoryMd = join(memoryDir, "MEMORY.md");
    expect(existsSync(memoryMd)).toBe(true);
    const content = await readFile(memoryMd, "utf-8");
    expect(content).toContain("build-digest-");
    expect(content).toContain("my-slug");
  });

  test("appends to existing MEMORY.md (does not overwrite)", async () => {
    await writeFile(join(workspace, "journal.json"), FIXTURE_JOURNAL, "utf-8");

    // Pre-create MEMORY.md with an existing entry
    const existingEntry =
      "- [some-prior-entry.md](some-prior-entry.md) -- prior build: CLEAN, 10m\n";
    await writeFile(join(memoryDir, "MEMORY.md"), existingEntry, "utf-8");

    const result = await tryWriteBuildDigest(workspace, "/Users/mock/project");
    expect(result).toBe(true);

    const content = await readFile(join(memoryDir, "MEMORY.md"), "utf-8");
    expect(content).toContain("some-prior-entry.md");
    expect(content).toContain("build-digest-");
  });

  test("does not duplicate MEMORY.md entry when called twice for the same slug/date", async () => {
    await writeFile(join(workspace, "journal.json"), FIXTURE_JOURNAL, "utf-8");

    // First call — creates digest and appends entry
    const result1 = await tryWriteBuildDigest(workspace, "/Users/mock/project");
    expect(result1).toBe(true);

    // Second call — same slug/date, same filename
    const result2 = await tryWriteBuildDigest(workspace, "/Users/mock/project");
    expect(result2).toBe(true);

    const content = await readFile(join(memoryDir, "MEMORY.md"), "utf-8");
    // Count occurrences of "my-slug" in MEMORY.md — should appear exactly once
    const matches = content.match(/build-digest-.*my-slug/g);
    expect(matches?.length).toBe(1);
  });

  test("returns false gracefully when auto-memory dir does not exist", async () => {
    await writeFile(join(workspace, "journal.json"), FIXTURE_JOURNAL, "utf-8");

    // Point homedir somewhere with no memory dir
    vi.mocked(homedir).mockReturnValue("/nonexistent-home-xyz");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const result = await tryWriteBuildDigest(workspace, "/Users/mock/project");
    expect(result).toBe(false);
    // Should not throw
    warnSpy.mockRestore();
  });

  test("returns false gracefully when workspace has malformed journal.json", async () => {
    await writeFile(join(workspace, "journal.json"), "this is not valid json {{{", "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const result = await tryWriteBuildDigest(workspace, "/Users/mock/project");
    expect(result).toBe(false);
    warnSpy.mockRestore();
  });

  test("returns true when journal.json does not exist (digest written with zero steps)", async () => {
    // Empty workspace — no journal.json. readJournalSteps returns [] when file is absent,
    // so extractDigestData still produces valid DigestData with zero steps.
    // The function succeeds as long as the auto-memory directory exists.
    const result = await tryWriteBuildDigest(workspace, "/Users/mock/project");
    expect(result).toBe(true);
  });
});
