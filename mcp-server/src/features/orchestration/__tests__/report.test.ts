import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { reportInputSchema } from "@shared/schema.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { report } from "../tools/report.ts";
import { CORRECTNESS_SCAN_PRINCIPLE_ID } from "../tools/write-review.ts";

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
    // Each test uses a unique tmpDir, so the module-level DriftDb cache
    // in drift-db.ts is effectively isolated between tests.
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

  // --- Craft profile path tests ---

  it("persists N area rows (source:review) when craft_profile is provided", async () => {
    const result = await report(
      {
        files: [
          "mcp-server/src/features/orchestration/tools/report.ts",
          "mcp-server/src/features/pr-review/tools/store-pr-review.ts",
        ],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 0 },
        },
        type: "review",
        violations: [],
        craft_profile: {
          ratings: [
            { dimension: "simplicity", band: "strong" },
            { dimension: "cohesion", band: "adequate" },
          ],
          rollup: 2.5,
        },
      },
      tmpDir,
    );

    expect(result.recorded).toBe(true);

    // files map to 2 distinct subsystem keys:
    //   "features/orchestration" and "features/pr-review"
    const dao = getDriftDb(tmpDir).getCraftProfiles();
    const rows = dao.getRecentProfiles(10);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const sources = rows.map((r) => r.source);
    expect(sources.every((s) => s === "review")).toBe(true);
    const rollups = rows.map((r) => r.rollup);
    expect(rollups.every((r) => r === 2.5)).toBe(true);
  });

  it("writes zero craft rows when craft_profile is absent", async () => {
    await report(
      {
        files: ["mcp-server/src/features/orchestration/tools/report.ts"],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 0 },
        },
        type: "review",
        violations: [],
        // no craft_profile
      },
      tmpDir,
    );

    const dao = getDriftDb(tmpDir).getCraftProfiles();
    const rows = dao.getRecentProfiles(10);
    expect(rows).toHaveLength(0);
  });

  it("throws and writes zero craft rows when craft_profile has an invalid band", async () => {
    await expect(
      report(
        {
          files: ["mcp-server/src/features/orchestration/tools/report.ts"],
          honored: [],
          score: {
            conventions: { passed: 0, total: 0 },
            opinions: { passed: 0, total: 0 },
            rules: { passed: 0, total: 0 },
          },
          type: "review",
          violations: [],
          craft_profile: {
            ratings: [{ dimension: "simplicity", band: "excellent" as never }],
          },
        },
        tmpDir,
      ),
    ).rejects.toThrow("Invalid craft_profile");

    const dao = getDriftDb(tmpDir).getCraftProfiles();
    const rows = dao.getRecentProfiles(10);
    expect(rows).toHaveLength(0);
  });

  // ---- correctness-scan: stored for presentation, excluded from analytics ----

  it("stores correctness-scan violations in the review record (for human presentation)", async () => {
    // correctness-scan findings must be stored so show_pr_impact can surface them to humans.
    // Analytics exclusion happens at aggregation time in analyzer.ts.
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
        violations: [{ principle_id: CORRECTNESS_SCAN_PRINCIPLE_ID, severity: "rule" }],
      },
      tmpDir,
    );

    const store = new DriftStore(tmpDir);
    const entries = await store.getReviews();
    expect(entries).toHaveLength(1);
    const stored = entries[0];
    // correctness-scan IS stored — show_pr_impact reads from this record
    expect(stored.violations.map((v) => v.principle_id)).toContain(CORRECTNESS_SCAN_PRINCIPLE_ID);
    expect(stored.violations).toHaveLength(1);
  });

  it("stores both real violations and correctness-scan in the same review record", async () => {
    // Mixed review: real violation + correctness-scan finding.
    // Both stored for presentation; analytics layer filters at aggregation time.
    await report(
      {
        files: ["src/a.ts"],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 2 },
        },
        type: "review",
        violations: [
          { principle_id: "errors-are-values", severity: "rule" },
          { principle_id: CORRECTNESS_SCAN_PRINCIPLE_ID, severity: "rule" },
        ],
      },
      tmpDir,
    );

    const store = new DriftStore(tmpDir);
    const entries = await store.getReviews();
    expect(entries).toHaveLength(1);
    const stored = entries[0];
    // Both violations stored
    expect(stored.violations).toHaveLength(2);
    const ids = stored.violations.map((v) => v.principle_id);
    expect(ids).toContain("errors-are-values");
    expect(ids).toContain(CORRECTNESS_SCAN_PRINCIPLE_ID);
  });

  it("derives verdict from analytics violations only (correctness-scan excluded from verdict)", async () => {
    // Input has only a correctness-scan violation (would be BLOCKING if counted).
    // Without it in the analytics path, verdict should be CLEAN.
    await report(
      {
        files: ["src/a.ts"],
        honored: [],
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 1, total: 1 },
        },
        type: "review",
        violations: [{ principle_id: CORRECTNESS_SCAN_PRINCIPLE_ID, severity: "rule" }],
      },
      tmpDir,
    );

    const store = new DriftStore(tmpDir);
    const entries = await store.getReviews();
    expect(entries[0].verdict).toBe("CLEAN");
  });
});
