import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DriftStore } from "../drift/store.ts";
import { reportInputSchema } from "../schema.ts";
import { report } from "../tools/report.ts";

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
    expect(() => reportInputSchema.parse({ type: "unknown", foo: "bar" })).toThrow();
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
    // Each test uses a unique tmpDir so no explicit cache clearing is needed.
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
      tmpDir,
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
      tmpDir,
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
      tmpDir,
    );

    const store = new DriftStore(tmpDir);
    const entries = await store.getReviews();
    expect(entries[0].verdict).toBe("WARNING");
  });
});
