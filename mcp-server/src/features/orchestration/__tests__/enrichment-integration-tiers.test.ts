/**
 * Context Enrichment Integration Tests — Tiers, Drift, Workspace, and DriftDb
 *
 * Split from enrichment-integration.test.ts. Covers:
 * 5. escapeDollarBrace on git commit messages containing ${...}
 * 6. DriftDb.getReviewsByFiles: malformed JSON in files column (Known Gap enr-01)
 * 7. assembleWorkspaceSection: REVIEW.md file type and 3-workspace cap
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { DriftDb } from "@platform/storage/drift/drift-db.ts";
import { initDriftDb } from "@platform/storage/drift/drift-schema.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module mocks for context-enrichment tests

vi.mock("@platform/adapters/git-adapter.ts", () => ({
  gitLog: vi.fn(),
}));

vi.mock("@platform/storage/drift/store.ts", () => ({
  DriftStore: vi.fn(function () {
    return {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock("../services/scope-resolver.ts", () => ({
  resolveTaskScope: vi.fn(),
}));

// Imports (after mocks)

import { gitLog } from "@platform/adapters/git-adapter.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { assembleEnrichment, type EnrichmentInput } from "../services/context-enrichment.ts";
import { resolveTaskScope } from "../services/scope-resolver.ts";

// Helpers shared across sections

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "implement",
    entry: "implement",
    flow: "build",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "Test task",
    ...overrides,
  };
}

function makeFlow(tier = "feature"): ResolvedFlow {
  return {
    description: "Build flow",
    entry: "implement",
    name: "build",
    params: {},
    states: {
      implement: {
        spawn: { agent: "canon-implementor", prompt: "implement" },
        transitions: { done: "terminal" },
        type: "single",
      },
      terminal: { type: "terminal" },
    },
    tier,
  } as unknown as ResolvedFlow;
}

function makeInput(overrides: Partial<EnrichmentInput> = {}): EnrichmentInput {
  return {
    board: makeBoard(),
    cwd: "/tmp/project",
    flow: makeFlow(),
    projectDir: "/tmp/project",
    stateId: "implement",
    workspace: "/tmp/workspace",
    ...overrides,
  };
}

function makeGitOk(stdout: string) {
  return {
    duration_ms: 20,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout,
    timedOut: false,
  };
}

// 5. escapeDollarBrace on git commit messages containing ${...}

describe("enrichment integration — escapeDollarBrace on git commit messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("escapes ${VARIABLE} in commit subject before injection into output", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/config.ts"]);

    vi.mocked(gitLog).mockReturnValue(
      makeGitOk("abc1234 Inject ${CANON_PLUGIN_ROOT} into environment"),
    );

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ projectDir: undefined }));

    // The literal ${CANON_PLUGIN_ROOT} must be escaped so template substitution
    // does not treat it as a variable reference
    expect(result.content).toContain("\\${CANON_PLUGIN_ROOT}");
    expect(result.content).not.toMatch(/(?<!\\)\$\{CANON_PLUGIN_ROOT\}/);
  });

  it("escapes ${task}, ${enrichment}, ${progress} which are Canon template variables", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/spawn.ts"]);

    vi.mocked(gitLog).mockReturnValue(
      makeGitOk("abc1234 Add ${task} and ${enrichment} and ${progress} to prompt"),
    );

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ projectDir: undefined }));

    // All three Canon template variables must be escaped
    expect(result.content).toContain("\\${task}");
    expect(result.content).toContain("\\${enrichment}");
    expect(result.content).toContain("\\${progress}");
    expect(result.content).not.toMatch(/(?<!\\)\$\{task\}/);
    expect(result.content).not.toMatch(/(?<!\\)\$\{enrichment\}/);
    expect(result.content).not.toMatch(/(?<!\\)\$\{progress\}/);
  });

  it("commit SHA prefix is not treated as part of subject (SHA has no dollar signs)", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);

    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Normal commit without dollar braces"));

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ projectDir: undefined }));

    // SHA should not appear in the output (it's stripped by space split)
    // Subject should appear normally
    expect(result.content).toContain("Normal commit without dollar braces");
    expect(result.content).not.toContain("abc1234 Normal");
  });
});

// 6. DriftDb.getReviewsByFiles: malformed JSON in files column (Known Gap enr-01)

describe("DriftDb.getReviewsByFiles — malformed JSON in files column", () => {
  it("silently skips reviews with malformed files JSON and returns only valid matching reviews", () => {
    const db = initDriftDb(":memory:");
    const store = new DriftDb(db);

    // Insert a valid review
    const validEntry: ReviewEntry = {
      files: ["src/foo.ts"],
      honored: [],
      review_id: "rev_valid_001",
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 1, total: 1 },
        rules: { passed: 1, total: 1 },
      },
      timestamp: new Date().toISOString(),
      verdict: "CLEAN",
      violations: [],
    };
    store.appendReview(validEntry);

    // Manually corrupt the files column of a second review in the DB
    // (simulate old data or a write bug)
    db.prepare(
      `INSERT INTO reviews (review_id, timestamp, files, honored, score, verdict)
       VALUES ('rev_corrupt', '2026-01-01T00:00:00Z', 'NOT_VALID_JSON', '[]', '{}', 'CLEAN')`,
    ).run();

    const results = store.getReviewsByFiles(["src/foo.ts"]);

    // Only the valid review should be returned; the corrupt row is silently skipped
    expect(results).toHaveLength(1);
    expect(results[0].review_id).toBe("rev_valid_001");

    store.close();
  });

  it("returns empty array when only malformed entries exist for the queried files", () => {
    const db = initDriftDb(":memory:");
    const store = new DriftDb(db);

    // Corrupt entry only
    db.prepare(
      `INSERT INTO reviews (review_id, timestamp, files, honored, score, verdict)
       VALUES ('rev_corrupt2', '2026-01-01T00:00:00Z', '{broken json', '[]', '{}', 'CLEAN')`,
    ).run();

    const results = store.getReviewsByFiles(["src/foo.ts"]);
    expect(results).toEqual([]);

    store.close();
  });
});

// 7. assembleWorkspaceSection: REVIEW.md file type and 3-workspace cap

describe("enrichment integration — workspace section edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "enr-ws-"));
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));
    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("includes prior workspace when matching file is found in REVIEW.md (not just DESIGN.md)", async () => {
    const currentWs = join(tmpDir, "current-ws");
    const siblingWs = join(tmpDir, "sibling-ws");
    const reviewsDir = join(siblingWs, "reviews");

    mkdirSync(currentWs, { recursive: true });
    mkdirSync(reviewsDir, { recursive: true });

    // Place a matching REVIEW.md in the sibling workspace
    writeFileSync(
      join(reviewsDir, "REVIEW.md"),
      "# Review\n\nThis review covers `src/important.ts` in detail.\n",
    );

    vi.mocked(resolveTaskScope).mockReturnValue(["src/important.ts"]);

    const result = await assembleEnrichment(
      makeInput({ projectDir: undefined, workspace: currentWs }),
    );

    expect(result.content).toContain("Prior Work");
    expect(result.content).toContain("sibling-ws");
  });

  it("caps prior work at 3 sibling workspace references even when 5 exist", async () => {
    const currentWs = join(tmpDir, "current-ws");
    mkdirSync(currentWs, { recursive: true });

    // Create 5 sibling workspaces each with a matching DESIGN.md
    for (let i = 1; i <= 5; i++) {
      const siblingPlansDir = join(tmpDir, `sibling-${i}`, "plans", "plan");
      mkdirSync(siblingPlansDir, { recursive: true });
      writeFileSync(
        join(siblingPlansDir, "DESIGN.md"),
        `# Design\n\nCovers \`src/shared.ts\` usage.\n`,
      );
    }

    vi.mocked(resolveTaskScope).mockReturnValue(["src/shared.ts"]);

    const result = await assembleEnrichment(
      makeInput({ projectDir: undefined, workspace: currentWs }),
    );

    // Count "sibling-N" references in the output
    const siblingRefs = (result.content.match(/\*\*sibling-\d+\*\*/g) ?? []).length;
    expect(siblingRefs).toBeLessThanOrEqual(3);
    expect(siblingRefs).toBeGreaterThan(0);
  });

  it("workspace with neither DESIGN.md nor REVIEW.md matching is excluded", async () => {
    const currentWs = join(tmpDir, "current-ws");
    const siblingWs = join(tmpDir, "sibling-irrelevant");
    const siblingPlansDir = join(siblingWs, "plans", "p");

    mkdirSync(currentWs, { recursive: true });
    mkdirSync(siblingPlansDir, { recursive: true });

    writeFileSync(
      join(siblingPlansDir, "DESIGN.md"),
      "# Design for unrelated task\nThis covers `src/unrelated-module.ts`.\n",
    );

    vi.mocked(resolveTaskScope).mockReturnValue(["src/important.ts"]);

    const result = await assembleEnrichment(
      makeInput({ projectDir: undefined, workspace: currentWs }),
    );

    expect(result.content).not.toContain("sibling-irrelevant");
  });
});
