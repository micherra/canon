import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IDriftStore } from "@domains/drift/drift-store.interface.ts";
// Clear the DriftDb module cache between tests
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { reportInputSchema } from "@shared/schema.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { report } from "../tools/report.ts";

// --- Schema validation ---

describe("reportInputSchema", () => {
  it("parses a review with optional file_path and impact_score on violations", () => {
    const input = {
      files: ["src/a.ts"],
      honored: [],
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 1 },
      },
      type: "review" as const,
      violations: [
        { file_path: "src/a.ts", impact_score: 5.2, principle_id: "p1", severity: "rule" },
      ],
    };
    const parsed = reportInputSchema.parse(input);
    if (parsed.type === "review") {
      expect(parsed.violations[0].file_path).toBe("src/a.ts");
      expect(parsed.violations[0].impact_score).toBe(5.2);
    }
  });

  it("rejects input with invalid type discriminant", () => {
    expect(() => reportInputSchema.parse({ foo: "bar", type: "unknown" })).toThrow();
  });

  it("rejects input with missing required fields for review", () => {
    expect(() => reportInputSchema.parse({ type: "review" })).toThrow();
  });
});

// --- report() integration with real temp directory ---

describe("report()", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-test-"));
  });

  afterEach(async () => {
    // Clear DriftDb cache so each test gets a fresh DB
    const _cache = (getDriftDb as any).__cache ?? (globalThis as any).__driftDbCache;
    // Access the module-level cache via a side-channel approach
    // The cache is a module-scoped Map in drift-db.ts; clear it via the exported function
    // by closing the DB for this tmpDir. Since we can't directly access the cache,
    // we rely on each test using a unique tmpDir.
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("records a review with derived BLOCKING verdict (rule violation)", async () => {
    const result = await report(
      {
        files: ["src/a.ts"],
        honored: ["p2"],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 0, total: 1 },
        },
        type: "review",
        violations: [{ principle_id: "p1", severity: "rule" }],
      },
      tmpDir,
    );

    expect(result.recorded).toBe(true);
    expect(result.id).toMatch(/^rev_/);

    const store = new DriftStore(tmpDir);
    const entries = await store.getReviews();
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe("BLOCKING");
  });

  it("derives WARNING verdict for strong-opinion violation", async () => {
    await report(
      {
        files: ["src/a.ts"],
        honored: ["p2"],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        type: "review",
        violations: [{ principle_id: "p1", severity: "strong-opinion" }],
      },
      tmpDir,
    );

    const store = new DriftStore(tmpDir);
    const entries = await store.getReviews();
    expect(entries[0].verdict).toBe("WARNING");
  });

  it("derives CLEAN verdict when no violations", async () => {
    await report(
      {
        files: ["src/a.ts"],
        honored: ["p1", "p2"],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 2, total: 2 },
        },
        type: "review",
        violations: [],
      },
      tmpDir,
    );

    const store = new DriftStore(tmpDir);
    const entries = await store.getReviews();
    expect(entries[0].verdict).toBe("CLEAN");
  });

  it("uses explicit verdict when provided instead of deriving", async () => {
    await report(
      {
        files: ["src/a.ts"],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 1 },
        },
        type: "review",
        verdict: "WARNING", // explicit override — would be BLOCKING if derived
        violations: [{ principle_id: "p1", severity: "rule" }],
      },
      tmpDir,
    );

    const store = new DriftStore(tmpDir);
    const entries = await store.getReviews();
    expect(entries[0].verdict).toBe("WARNING");
  });
});

// --- report() with injected IDriftStore (DI parameter path) ---

describe("report() — injected IDriftStore", () => {
  function makeMockStore(): IDriftStore & { appendReview: ReturnType<typeof vi.fn> } {
    return {
      appendFlowRun: vi.fn().mockResolvedValue(undefined),
      appendReview: vi.fn().mockResolvedValue(undefined),
      countFlowRunsSince: vi.fn().mockReturnValue(0),
      getComplianceTrend: vi.fn().mockResolvedValue([]),
      getLastReviewForBranch: vi.fn().mockResolvedValue(null),
      getLastReviewForPr: vi.fn().mockResolvedValue(null),
      getReviews: vi.fn().mockResolvedValue([]),
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
  }

  it("calls appendReview on the injected store with correct entry fields", async () => {
    const mockStore = makeMockStore();

    const result = await report(
      {
        files: ["src/a.ts"],
        honored: ["p2"],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 0, total: 1 },
        },
        type: "review",
        violations: [{ principle_id: "p1", severity: "rule" }],
      },
      "/unused/projectDir",
      mockStore,
    );

    expect(result.recorded).toBe(true);
    expect(result.id).toMatch(/^rev_/);
    expect(mockStore.appendReview).toHaveBeenCalledOnce();

    const entry = mockStore.appendReview.mock.calls[0][0];
    expect(entry.verdict).toBe("BLOCKING");
    expect(entry.files).toEqual(["src/a.ts"]);
    expect(entry.violations).toHaveLength(1);
    expect(entry.violations[0].principle_id).toBe("p1");
    // Violated principle must be excluded from honored list
    expect(entry.honored).not.toContain("p1");
    expect(entry.honored).toContain("p2");
  });

  it("derives WARNING verdict from strong-opinion violation via injected store", async () => {
    const mockStore = makeMockStore();

    await report(
      {
        files: ["src/b.ts"],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        type: "review",
        violations: [{ principle_id: "p2", severity: "strong-opinion" }],
      },
      "/unused/projectDir",
      mockStore,
    );

    const entry = mockStore.appendReview.mock.calls[0][0];
    expect(entry.verdict).toBe("WARNING");
  });

  it("uses explicit verdict when provided, overriding derivation logic", async () => {
    const mockStore = makeMockStore();

    await report(
      {
        files: ["src/c.ts"],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 1 },
        },
        type: "review",
        verdict: "CLEAN", // explicit — overrides the rule violation that would produce BLOCKING
        violations: [{ principle_id: "p1", severity: "rule" }],
      },
      "/unused/projectDir",
      mockStore,
    );

    const entry = mockStore.appendReview.mock.calls[0][0];
    expect(entry.verdict).toBe("CLEAN");
  });

  it("does not construct a real DriftStore when driftStore is injected", async () => {
    // This test verifies the backward-compat parameter is truly honored —
    // report() must NOT attempt to open drift.db at a nonexistent path.
    const mockStore = makeMockStore();
    const nonexistentDir = "/absolutely/does/not/exist/on/this/machine";

    // Should not throw despite nonexistent projectDir because the injected store is used
    await expect(
      report(
        {
          files: [],
          honored: [],
          score: {
            conventions: { passed: 0, total: 0 },
            opinions: { passed: 0, total: 0 },
            rules: { passed: 0, total: 0 },
          },
          type: "review",
          violations: [],
        },
        nonexistentDir,
        mockStore,
      ),
    ).resolves.toBeDefined();

    expect(mockStore.appendReview).toHaveBeenCalledOnce();
  });
});
