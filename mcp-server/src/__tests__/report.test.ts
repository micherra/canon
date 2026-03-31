import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { reportInputSchema } from "../schema.ts";
import { report } from "../tools/report.ts";
import { DriftStore } from "../drift/store.ts";

// Clear the DriftDb module cache between tests
import { getDriftDb } from "../drift/drift-db.ts";

// --- Schema validation ---

describe("reportInputSchema", () => {
  it("parses a review with optional file_path and impact_score on violations", () => {
    const input = {
      type: "review" as const,
      files: ["src/a.ts"],
      violations: [{ principle_id: "p1", severity: "rule", file_path: "src/a.ts", impact_score: 5.2 }],
      honored: [],
      score: {
        rules: { passed: 0, total: 1 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
    };
    const parsed = reportInputSchema.parse(input);
    if (parsed.type === "review") {
      expect(parsed.violations[0].file_path).toBe("src/a.ts");
      expect(parsed.violations[0].impact_score).toBe(5.2);
    }
  });

  it("rejects input with invalid type discriminant", () => {
    expect(() =>
      reportInputSchema.parse({ type: "unknown", foo: "bar" })
    ).toThrow();
  });

  it("rejects input with missing required fields for review", () => {
    expect(() =>
      reportInputSchema.parse({ type: "review" })
    ).toThrow();
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
    const cache = (getDriftDb as any).__cache ?? (globalThis as any).__driftDbCache;
    // Access the module-level cache via a side-channel approach
    // The cache is a module-scoped Map in drift-db.ts; clear it via the exported function
    // by closing the DB for this tmpDir. Since we can't directly access the cache,
    // we rely on each test using a unique tmpDir.
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("records a review with derived BLOCKING verdict (rule violation)", async () => {
    const result = await report(
      {
        type: "review",
        files: ["src/a.ts"],
        violations: [{ principle_id: "p1", severity: "rule" }],
        honored: ["p2"],
        score: {
          rules: { passed: 0, total: 1 },
          opinions: { passed: 1, total: 1 },
          conventions: { passed: 0, total: 0 },
        },
      },
      tmpDir
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
        type: "review",
        files: ["src/a.ts"],
        violations: [{ principle_id: "p1", severity: "strong-opinion" }],
        honored: ["p2"],
        score: {
          rules: { passed: 1, total: 1 },
          opinions: { passed: 0, total: 1 },
          conventions: { passed: 0, total: 0 },
        },
      },
      tmpDir
    );

    const store = new DriftStore(tmpDir);
    const entries = await store.getReviews();
    expect(entries[0].verdict).toBe("WARNING");
  });

  it("derives CLEAN verdict when no violations", async () => {
    await report(
      {
        type: "review",
        files: ["src/a.ts"],
        violations: [],
        honored: ["p1", "p2"],
        score: {
          rules: { passed: 2, total: 2 },
          opinions: { passed: 1, total: 1 },
          conventions: { passed: 0, total: 0 },
        },
      },
      tmpDir
    );

    const store = new DriftStore(tmpDir);
    const entries = await store.getReviews();
    expect(entries[0].verdict).toBe("CLEAN");
  });

  it("uses explicit verdict when provided instead of deriving", async () => {
    await report(
      {
        type: "review",
        files: ["src/a.ts"],
        violations: [{ principle_id: "p1", severity: "rule" }],
        honored: [],
        score: {
          rules: { passed: 0, total: 1 },
          opinions: { passed: 0, total: 0 },
          conventions: { passed: 0, total: 0 },
        },
        verdict: "WARNING", // explicit override — would be BLOCKING if derived
      },
      tmpDir
    );

    const store = new DriftStore(tmpDir);
    const entries = await store.getReviews();
    expect(entries[0].verdict).toBe("WARNING");
  });
});
