/**
 * Integration tests for the new UnifiedPrOutput fields (pr-dash-01 task):
 *   - subsystems: Subsystem[]
 *   - blast_radius_by_file: BlastRadiusFileEntry[]
 *
 * Coverage gaps addressed:
 *   1. UnifiedPrOutput always includes subsystems and blast_radius_by_file (no-review early return)
 *   2. Full showPrImpact pipeline populates subsystems from prep file statuses
 *   3. Full showPrImpact pipeline populates blast_radius_by_file from KG blast radius data
 *   4. Full showPrImpact pipeline with KG present: blast_radius_by_file non-empty
 *   5. Cross-task contract: prep.files status map drives detectSubsystems in full pipeline
 *   6. detectSubsystems: "modified"/"renamed" files do NOT count toward subsystem thresholds (implementor-declared known gap)
 *   7. buildBlastRadiusByFile: entries with empty/falsy file_path are skipped (implementor-declared known gap)
 *   8. Threshold boundary: exactly 3 files triggers subsystem (inclusive threshold)
 *   9. Threshold boundary: exactly 2 files does NOT trigger subsystem
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before imports of mocked modules
// ---------------------------------------------------------------------------

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

vi.mock("../graph/kg-schema.js", () => ({
  initDatabase: vi.fn(),
}));

vi.mock("../graph/kg-blast-radius.js", () => ({
  analyzeBlastRadius: vi.fn(),
}));

vi.mock("../tools/pr-review-data.js", () => ({
  getPrReviewData: vi.fn(),
}));

import { existsSync } from "fs";
import { initDatabase } from "../graph/kg-schema.ts";
import { analyzeBlastRadius } from "../graph/kg-blast-radius.ts";
import { getPrReviewData } from "../tools/pr-review-data.ts";

import { showPrImpact } from "../tools/show-pr-impact.ts";
import { detectSubsystems, buildBlastRadiusByFile } from "../tools/show-pr-impact.ts";
import { DriftStore } from "../drift/store.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SAMPLE_SCORE = {
  rules: { passed: 2, total: 3 },
  opinions: { passed: 1, total: 2 },
  conventions: { passed: 3, total: 3 },
};

/** Minimal PrReviewDataOutput stub — all tests override this via vi.mocked */
function makePrepStub(fileOverrides: Array<{ path: string; status: string }> = []) {
  return {
    files: fileOverrides.map((f) => ({
      path: f.path,
      layer: "tools",
      status: f.status,
      bucket: "low-risk" as const,
      reason: "test",
    })),
    layers: [],
    total_files: fileOverrides.length,
    incremental: false,
    diff_command: "git diff main",
    narrative: "Test narrative.",
    blast_radius: [],
  };
}

function makeReview(overrides: Partial<{
  files: string[];
  violations: Array<{ principle_id: string; severity: string; file_path?: string }>;
  verdict: "BLOCKING" | "WARNING" | "CLEAN";
}> = {}) {
  return {
    review_id: "rev_test_" + Math.random().toString(36).slice(2),
    timestamp: new Date().toISOString(),
    verdict: overrides.verdict ?? ("CLEAN" as const),
    branch: "feat/test",
    pr_number: 99,
    files: overrides.files ?? [],
    violations: overrides.violations ?? [],
    honored: [],
    score: SAMPLE_SCORE,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: UnifiedPrOutput shape always includes new fields
// ---------------------------------------------------------------------------

describe("showPrImpact — new fields present in all output paths", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-newfields-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(initDatabase).mockReset();
    vi.mocked(analyzeBlastRadius).mockReset();
    vi.mocked(getPrReviewData).mockReset();
    vi.mocked(getPrReviewData).mockResolvedValue(makePrepStub() as never);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("no-review early return includes subsystems as empty array", async () => {
    // No stored review — exercises the early return path in showPrImpact
    const result = await showPrImpact(tmpDir);

    expect(result).toHaveProperty("subsystems");
    expect(result.subsystems).toEqual([]);
  });

  it("no-review early return includes blast_radius_by_file as empty array", async () => {
    const result = await showPrImpact(tmpDir);

    expect(result).toHaveProperty("blast_radius_by_file");
    expect(result.blast_radius_by_file).toEqual([]);
  });

  it("full pipeline with review returns subsystems field (may be empty when no threshold reached)", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({
      files: ["src/a.ts", "src/b.ts"],
    }));

    vi.mocked(getPrReviewData).mockResolvedValue(
      makePrepStub([
        { path: "src/a.ts", status: "added" },
        { path: "src/b.ts", status: "added" },
      ]) as never,
    );

    const result = await showPrImpact(tmpDir);

    // Field always present — threshold not met (only 2 files), so empty
    expect(result).toHaveProperty("subsystems");
    expect(Array.isArray(result.subsystems)).toBe(true);
    expect(result.subsystems).toEqual([]);
  });

  it("full pipeline with review returns blast_radius_by_file field (empty without KG)", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({
      files: ["src/a.ts"],
    }));

    vi.mocked(existsSync).mockReturnValue(false); // no KG

    const result = await showPrImpact(tmpDir);

    expect(result).toHaveProperty("blast_radius_by_file");
    expect(Array.isArray(result.blast_radius_by_file)).toBe(true);
    expect(result.blast_radius_by_file).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: showPrImpact subsystems cross-task integration
// (prep.files status map → detectSubsystems in full pipeline)
// ---------------------------------------------------------------------------

describe("showPrImpact — subsystems populated from prep file statuses", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-subsystems-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(initDatabase).mockReset();
    vi.mocked(analyzeBlastRadius).mockReset();
    vi.mocked(getPrReviewData).mockReset();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("detects a new subsystem when 3+ review files are added in the same directory", async () => {
    const reviewFiles = [
      "src/widgets/alpha.ts",
      "src/widgets/beta.ts",
      "src/widgets/gamma.ts",
    ];

    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ files: reviewFiles }));

    // prep reports all 3 files as "added"
    vi.mocked(getPrReviewData).mockResolvedValue(
      makePrepStub(reviewFiles.map((p) => ({ path: p, status: "added" }))) as never,
    );

    const result = await showPrImpact(tmpDir);

    expect(result.subsystems).toHaveLength(1);
    expect(result.subsystems[0]).toMatchObject({
      directory: "src/widgets",
      label: "new",
      file_count: 3,
    });
  });

  it("detects a removed subsystem when 3+ review files are deleted in the same directory", async () => {
    const reviewFiles = [
      "src/legacy/a.ts",
      "src/legacy/b.ts",
      "src/legacy/c.ts",
      "src/legacy/d.ts",
    ];

    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ files: reviewFiles }));

    vi.mocked(getPrReviewData).mockResolvedValue(
      makePrepStub(reviewFiles.map((p) => ({ path: p, status: "deleted" }))) as never,
    );

    const result = await showPrImpact(tmpDir);

    expect(result.subsystems).toHaveLength(1);
    expect(result.subsystems[0]).toMatchObject({
      directory: "src/legacy",
      label: "removed",
      file_count: 4,
    });
  });

  it("does not detect subsystem when fewer than 3 files are added in a directory", async () => {
    const reviewFiles = ["src/widgets/alpha.ts", "src/widgets/beta.ts"];

    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ files: reviewFiles }));

    vi.mocked(getPrReviewData).mockResolvedValue(
      makePrepStub(reviewFiles.map((p) => ({ path: p, status: "added" }))) as never,
    );

    const result = await showPrImpact(tmpDir);

    expect(result.subsystems).toEqual([]);
  });

  it("cross-task contract: only prep.files status drives subsystem detection (not review.files status)", async () => {
    // Review files includes 3 files in src/widgets, but prep reports them as "modified" — no subsystem
    const reviewFiles = [
      "src/widgets/alpha.ts",
      "src/widgets/beta.ts",
      "src/widgets/gamma.ts",
    ];

    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ files: reviewFiles }));

    // Prep says "modified" — NOT "added"
    vi.mocked(getPrReviewData).mockResolvedValue(
      makePrepStub(reviewFiles.map((p) => ({ path: p, status: "modified" }))) as never,
    );

    const result = await showPrImpact(tmpDir);

    // "modified" status should NOT trigger subsystem detection
    expect(result.subsystems).toEqual([]);
  });

  it("multiple subsystems across different directories sorted by file_count descending", async () => {
    const reviewFiles = [
      "src/big/a.ts",
      "src/big/b.ts",
      "src/big/c.ts",
      "src/big/d.ts",
      "src/big/e.ts",
      "src/small/x.ts",
      "src/small/y.ts",
      "src/small/z.ts",
    ];

    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({ files: reviewFiles }));

    vi.mocked(getPrReviewData).mockResolvedValue(
      makePrepStub(reviewFiles.map((p) => ({ path: p, status: "added" }))) as never,
    );

    const result = await showPrImpact(tmpDir);

    expect(result.subsystems).toHaveLength(2);
    // Sorted descending by file_count — src/big (5 files) before src/small (3 files)
    expect(result.subsystems[0].directory).toBe("src/big");
    expect(result.subsystems[0].file_count).toBe(5);
    expect(result.subsystems[1].directory).toBe("src/small");
    expect(result.subsystems[1].file_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: showPrImpact blast_radius_by_file integration with KG
// ---------------------------------------------------------------------------

describe("showPrImpact — blast_radius_by_file populated from KG blast radius", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-blastfile-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(initDatabase).mockReset();
    vi.mocked(analyzeBlastRadius).mockReset();
    vi.mocked(getPrReviewData).mockReset();
    vi.mocked(getPrReviewData).mockResolvedValue(makePrepStub() as never);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("blast_radius_by_file populated from KG affected entities when KG is available", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({
      files: ["src/core.ts"],
    }));

    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue({
      seed_entities: ["core"],
      total_affected: 4,
      affected_files: 2,
      by_depth: { 1: 2, 2: 2 },
      affected: [
        { entity_name: "fn1", entity_kind: "function", file_path: "src/dep-a.ts", depth: 1, edge_type: "dependency" },
        { entity_name: "fn2", entity_kind: "function", file_path: "src/dep-a.ts", depth: 2, edge_type: "dependency" },
        { entity_name: "cls1", entity_kind: "class", file_path: "src/dep-b.ts", depth: 1, edge_type: "dependency" },
        { entity_name: "cls2", entity_kind: "class", file_path: "src/dep-b.ts", depth: 2, edge_type: "dependency" },
      ],
    });

    const result = await showPrImpact(tmpDir);

    expect(result.blast_radius_by_file).toHaveLength(2);
    const depA = result.blast_radius_by_file.find((e) => e.file === "src/dep-a.ts");
    const depB = result.blast_radius_by_file.find((e) => e.file === "src/dep-b.ts");

    expect(depA?.dep_count).toBe(2);
    expect(depB?.dep_count).toBe(2);
  });

  it("blast_radius_by_file is sorted descending by dep_count", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({
      files: ["src/core.ts"],
    }));

    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue({
      seed_entities: ["core"],
      total_affected: 6,
      affected_files: 3,
      by_depth: { 1: 6 },
      affected: [
        // dep-low: 1 entity, dep-high: 3 entities, dep-mid: 2 entities
        { entity_name: "e1", entity_kind: "function", file_path: "src/dep-low.ts", depth: 1, edge_type: "dependency" },
        { entity_name: "e2", entity_kind: "function", file_path: "src/dep-high.ts", depth: 1, edge_type: "dependency" },
        { entity_name: "e3", entity_kind: "function", file_path: "src/dep-high.ts", depth: 1, edge_type: "dependency" },
        { entity_name: "e4", entity_kind: "function", file_path: "src/dep-high.ts", depth: 1, edge_type: "dependency" },
        { entity_name: "e5", entity_kind: "function", file_path: "src/dep-mid.ts", depth: 1, edge_type: "dependency" },
        { entity_name: "e6", entity_kind: "function", file_path: "src/dep-mid.ts", depth: 1, edge_type: "dependency" },
      ],
    });

    const result = await showPrImpact(tmpDir);

    expect(result.blast_radius_by_file[0].file).toBe("src/dep-high.ts");
    expect(result.blast_radius_by_file[0].dep_count).toBe(3);
    expect(result.blast_radius_by_file[1].file).toBe("src/dep-mid.ts");
    expect(result.blast_radius_by_file[1].dep_count).toBe(2);
    expect(result.blast_radius_by_file[2].file).toBe("src/dep-low.ts");
    expect(result.blast_radius_by_file[2].dep_count).toBe(1);
  });

  it("blast_radius_by_file limited to 15 entries even when KG has more files", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({
      files: ["src/core.ts"],
    }));

    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);

    // 20 distinct files — should be capped at 15
    const affected = Array.from({ length: 20 }, (_, i) => ({
      entity_name: `e${i}`,
      entity_kind: "function",
      file_path: `src/file${i}.ts`,
      depth: 1,
      edge_type: "dependency",
    }));

    vi.mocked(analyzeBlastRadius).mockReturnValue({
      seed_entities: ["core"],
      total_affected: 20,
      affected_files: 20,
      by_depth: { 1: 20 },
      affected,
    });

    const result = await showPrImpact(tmpDir);

    expect(result.blast_radius_by_file).toHaveLength(15);
  });

  it("blast_radius_by_file entry shape matches BlastRadiusFileEntry contract", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview(makeReview({
      files: ["src/core.ts"],
    }));

    vi.mocked(existsSync).mockReturnValue(true);
    const mockDb = { close: vi.fn() };
    vi.mocked(initDatabase).mockReturnValue(mockDb as never);
    vi.mocked(analyzeBlastRadius).mockReturnValue({
      seed_entities: ["core"],
      total_affected: 1,
      affected_files: 1,
      by_depth: { 1: 1 },
      affected: [
        { entity_name: "fn", entity_kind: "function", file_path: "src/dep.ts", depth: 1, edge_type: "dependency" },
      ],
    });

    const result = await showPrImpact(tmpDir);

    expect(result.blast_radius_by_file).toHaveLength(1);
    const entry = result.blast_radius_by_file[0];
    expect(entry).toHaveProperty("file");
    expect(entry).toHaveProperty("dep_count");
    expect(typeof entry.file).toBe("string");
    expect(typeof entry.dep_count).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Suite 4: detectSubsystems declared known gaps (pure function tests)
// ---------------------------------------------------------------------------

describe("detectSubsystems — declared known gaps", () => {
  it("does not count 'modified' files toward subsystem threshold", () => {
    // Per design: only 'added' and 'deleted' trigger subsystem labels
    const files = [
      "src/widgets/alpha.ts",
      "src/widgets/beta.ts",
      "src/widgets/gamma.ts",
    ];
    const statusMap = new Map<string, string>([
      ["src/widgets/alpha.ts", "modified"],
      ["src/widgets/beta.ts", "modified"],
      ["src/widgets/gamma.ts", "modified"],
    ]);

    const result = detectSubsystems(files, statusMap);

    // 'modified' files do NOT count — result should be empty even with 3 files
    expect(result).toEqual([]);
  });

  it("does not count 'renamed' files toward subsystem threshold", () => {
    const files = [
      "src/widgets/alpha.ts",
      "src/widgets/beta.ts",
      "src/widgets/gamma.ts",
    ];
    const statusMap = new Map<string, string>([
      ["src/widgets/alpha.ts", "renamed"],
      ["src/widgets/beta.ts", "renamed"],
      ["src/widgets/gamma.ts", "renamed"],
    ]);

    const result = detectSubsystems(files, statusMap);

    expect(result).toEqual([]);
  });

  it("only 'added' files contribute to 'new' subsystem label", () => {
    // Mix of added + modified in same dir — only added files count
    const files = [
      "src/mixed/a.ts",
      "src/mixed/b.ts",
      "src/mixed/c.ts",  // modified — should not count
      "src/mixed/d.ts",  // modified — should not count
    ];
    const statusMap = new Map<string, string>([
      ["src/mixed/a.ts", "added"],
      ["src/mixed/b.ts", "added"],
      ["src/mixed/c.ts", "modified"],
      ["src/mixed/d.ts", "modified"],
    ]);

    const result = detectSubsystems(files, statusMap);

    // Only 2 "added" files — threshold not met — no subsystem
    expect(result).toEqual([]);
  });

  it("threshold is inclusive at exactly 3 — exactly 3 added files triggers subsystem", () => {
    const files = [
      "src/exact/a.ts",
      "src/exact/b.ts",
      "src/exact/c.ts",
    ];
    const statusMap = new Map<string, string>([
      ["src/exact/a.ts", "added"],
      ["src/exact/b.ts", "added"],
      ["src/exact/c.ts", "added"],
    ]);

    const result = detectSubsystems(files, statusMap);

    expect(result).toHaveLength(1);
    expect(result[0].file_count).toBe(3);
  });

  it("threshold boundary: exactly 2 files does NOT trigger subsystem", () => {
    const files = ["src/exact/a.ts", "src/exact/b.ts"];
    const statusMap = new Map<string, string>([
      ["src/exact/a.ts", "added"],
      ["src/exact/b.ts", "added"],
    ]);

    const result = detectSubsystems(files, statusMap);

    expect(result).toHaveLength(0);
  });

  it("file with no status in statusMap is not counted", () => {
    // File in list but no entry in statusMap — treated as having no counted status
    const files = [
      "src/ghost/a.ts",
      "src/ghost/b.ts",
      "src/ghost/c.ts",
    ];
    // statusMap is empty — none have a status
    const result = detectSubsystems(files, new Map());

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: buildBlastRadiusByFile declared known gaps
// ---------------------------------------------------------------------------

describe("buildBlastRadiusByFile — declared known gaps", () => {
  it("skips entries with empty string file_path", () => {
    const blastRadius = {
      total_affected: 3,
      affected_files: 1,
      by_depth: { 1: 3 },
      affected: [
        { entity_name: "fn1", entity_kind: "function", file_path: "", depth: 1 },
        { entity_name: "fn2", entity_kind: "function", file_path: "", depth: 1 },
        { entity_name: "fn3", entity_kind: "function", file_path: "src/real.ts", depth: 1 },
      ],
    };

    const result = buildBlastRadiusByFile(blastRadius);

    // Only the entry with a real file_path should be counted
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("src/real.ts");
    expect(result[0].dep_count).toBe(1);
  });

  it("skips entries with null-ish file_path (falsy guard covers undefined)", () => {
    const blastRadius = {
      total_affected: 2,
      affected_files: 1,
      by_depth: { 1: 2 },
      affected: [
        // TypeScript type says file_path is string, but at runtime guard handles falsy
        { entity_name: "fn1", entity_kind: "function", file_path: null as unknown as string, depth: 1 },
        { entity_name: "fn2", entity_kind: "function", file_path: "src/valid.ts", depth: 1 },
      ],
    };

    const result = buildBlastRadiusByFile(blastRadius);

    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("src/valid.ts");
  });

  it("returns empty array when all entries have empty file_path", () => {
    const blastRadius = {
      total_affected: 2,
      affected_files: 0,
      by_depth: { 1: 2 },
      affected: [
        { entity_name: "fn1", entity_kind: "function", file_path: "", depth: 1 },
        { entity_name: "fn2", entity_kind: "function", file_path: "", depth: 1 },
      ],
    };

    const result = buildBlastRadiusByFile(blastRadius);

    expect(result).toEqual([]);
  });

  it("returns empty array for blastRadius with empty affected array", () => {
    const blastRadius = {
      total_affected: 0,
      affected_files: 0,
      by_depth: {},
      affected: [],
    };

    const result = buildBlastRadiusByFile(blastRadius);

    expect(result).toEqual([]);
  });
});
