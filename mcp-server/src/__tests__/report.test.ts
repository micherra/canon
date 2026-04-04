import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Clear the DriftDb module cache between tests
import { getDriftDb } from "../drift/drift-db.ts";
import { DriftStore } from "../drift/store.ts";
import { reportInputSchema } from "../shared/schema.ts";
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
