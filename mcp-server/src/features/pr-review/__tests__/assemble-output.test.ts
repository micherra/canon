import { describe, expect, it } from "vitest";
import type { AssembleParams, PrFileInfo } from "../tools/pr-review-data.js";
import { assembleOutput } from "../tools/pr-review-data.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(overrides: Partial<PrFileInfo> = {}): PrFileInfo {
  return {
    bucket: "low-risk",
    layer: "tools",
    path: "src/file.ts",
    reason: "no violations",
    status: "modified",
    violations: [],
    ...overrides,
  };
}

function baseParams(overrides: Partial<AssembleParams> = {}): AssembleParams {
  return {
    blastRadius: [],
    diffCommand: "git diff main..HEAD --name-status",
    execError: undefined,
    files: [],
    hotspot_files: undefined,
    kgResult: undefined,
    lastReviewedSha: undefined,
    layers: [],
    narrative: "No changes detected.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Field mapping tests
// ---------------------------------------------------------------------------

describe("assembleOutput — field mapping", () => {
  it("maps diffCommand to diff_command", () => {
    const result = assembleOutput(baseParams({ diffCommand: "git diff main..HEAD --name-status" }));
    expect(result.diff_command).toBe("git diff main..HEAD --name-status");
  });

  it("maps narrative through unchanged", () => {
    const result = assembleOutput(baseParams({ narrative: "High-risk change in api layer." }));
    expect(result.narrative).toBe("High-risk change in api layer.");
  });

  it("maps blastRadius to blast_radius", () => {
    const blast = [{ affected: [{ depth: 1, path: "src/b.ts" }], file: "src/a.ts" }];
    const result = assembleOutput(baseParams({ blastRadius: blast }));
    expect(result.blast_radius).toEqual(blast);
  });

  it("maps layers through unchanged", () => {
    const layers = [{ file_count: 3, name: "tools" }];
    const result = assembleOutput(baseParams({ layers }));
    expect(result.layers).toEqual(layers);
  });

  it("maps kgResult.kgFreshnessMs to kg_freshness_ms", () => {
    const result = assembleOutput(baseParams({ kgResult: { kgFreshnessMs: 500 } }));
    expect(result.kg_freshness_ms).toBe(500);
  });

  it("omits kg_freshness_ms when kgResult is undefined", () => {
    const result = assembleOutput(baseParams({ kgResult: undefined }));
    expect(result.kg_freshness_ms).toBeUndefined();
  });

  it("maps lastReviewedSha to last_reviewed_sha and sets incremental: true", () => {
    const result = assembleOutput(baseParams({ lastReviewedSha: "abc123" }));
    expect(result.last_reviewed_sha).toBe("abc123");
    expect(result.incremental).toBe(true);
  });

  it("sets incremental: false when lastReviewedSha is undefined", () => {
    const result = assembleOutput(baseParams({ lastReviewedSha: undefined }));
    expect(result.incremental).toBe(false);
    expect(result.last_reviewed_sha).toBeUndefined();
  });

  it("sets hotspot_files when provided", () => {
    const result = assembleOutput(baseParams({ hotspot_files: ["src/hot.ts"] }));
    expect(result.hotspot_files).toEqual(["src/hot.ts"]);
  });

  it("omits hotspot_files when undefined", () => {
    const result = assembleOutput(baseParams({ hotspot_files: undefined }));
    expect(result.hotspot_files).toBeUndefined();
  });

  it("sets error field when execError is provided", () => {
    const result = assembleOutput(baseParams({ execError: "git not found" }));
    expect(result.error).toBe("git not found");
  });

  it("omits error field when execError is undefined", () => {
    const result = assembleOutput(baseParams({ execError: undefined }));
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Computed fields: total_files, total_violations, net_new_files
// ---------------------------------------------------------------------------

describe("assembleOutput — computed counts", () => {
  it("computes total_files from files array length", () => {
    const files = [
      makeFile({ path: "a.ts" }),
      makeFile({ path: "b.ts" }),
      makeFile({ path: "c.ts" }),
    ];
    const result = assembleOutput(baseParams({ files }));
    expect(result.total_files).toBe(3);
  });

  it("computes total_violations as sum of violations across all files", () => {
    const files = [
      makeFile({ violations: [{ principle_id: "p1", severity: "rule" }] }),
      makeFile({
        violations: [
          { principle_id: "p2", severity: "convention" },
          { principle_id: "p3", severity: "strong-opinion" },
        ],
      }),
      makeFile({ violations: [] }),
    ];
    const result = assembleOutput(baseParams({ files }));
    expect(result.total_violations).toBe(3);
  });

  it("counts violations as 0 when violations field is undefined", () => {
    const file = makeFile();
    delete (file as Partial<PrFileInfo>).violations;
    const result = assembleOutput(baseParams({ files: [file] }));
    expect(result.total_violations).toBe(0);
  });

  it("computes net_new_files as added minus deleted", () => {
    const files = [
      makeFile({ status: "added" }),
      makeFile({ status: "added" }),
      makeFile({ status: "deleted" }),
      makeFile({ status: "modified" }),
    ];
    const result = assembleOutput(baseParams({ files }));
    expect(result.net_new_files).toBe(1); // 2 added - 1 deleted
  });

  it("computes net_new_files as negative when more deleted than added", () => {
    const files = [makeFile({ status: "deleted" }), makeFile({ status: "deleted" })];
    const result = assembleOutput(baseParams({ files }));
    expect(result.net_new_files).toBe(-2);
  });

  it("returns zero for all counts on empty files array", () => {
    const result = assembleOutput(baseParams({ files: [] }));
    expect(result.total_files).toBe(0);
    expect(result.total_violations).toBe(0);
    expect(result.net_new_files).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// files (lightweight) vs impact_files (detail)
// ---------------------------------------------------------------------------

describe("assembleOutput — files vs impact_files projection", () => {
  it("strips files to path/layer/status only", () => {
    const file = makeFile({
      bucket: "needs-attention",
      layer: "api",
      path: "src/api/handler.ts",
      priority_score: 25,
      status: "added",
      violations: [{ principle_id: "p1", severity: "rule" }],
    });
    const result = assembleOutput(baseParams({ files: [file] }));
    expect(result.files[0]).toEqual({
      layer: "api",
      path: "src/api/handler.ts",
      status: "added",
    });
  });

  it("includes file in impact_files when bucket is needs-attention", () => {
    const file = makeFile({ bucket: "needs-attention", violations: [] });
    const result = assembleOutput(baseParams({ files: [file] }));
    expect(result.impact_files).toHaveLength(1);
    expect(result.impact_files[0].path).toBe(file.path);
  });

  it("includes file in impact_files when priority_score >= 15", () => {
    const file = makeFile({ bucket: "low-risk", priority_score: 15, violations: [] });
    const result = assembleOutput(baseParams({ files: [file] }));
    expect(result.impact_files).toHaveLength(1);
  });

  it("includes file in impact_files when it has violations", () => {
    const file = makeFile({
      bucket: "worth-a-look",
      violations: [{ principle_id: "p1", severity: "convention" }],
    });
    const result = assembleOutput(baseParams({ files: [file] }));
    expect(result.impact_files).toHaveLength(1);
  });

  it("excludes file from impact_files when low-risk, low priority, no violations", () => {
    const file = makeFile({ bucket: "low-risk", priority_score: 5, violations: [] });
    const result = assembleOutput(baseParams({ files: [file] }));
    expect(result.impact_files).toHaveLength(0);
  });

  it("excludes file from impact_files when priority_score is 14 (below threshold)", () => {
    const file = makeFile({ bucket: "low-risk", priority_score: 14, violations: [] });
    const result = assembleOutput(baseParams({ files: [file] }));
    expect(result.impact_files).toHaveLength(0);
  });

  it("includes file in impact_files when priority_score is undefined but bucket is needs-attention", () => {
    const file = makeFile({ bucket: "needs-attention", priority_score: undefined, violations: [] });
    const result = assembleOutput(baseParams({ files: [file] }));
    expect(result.impact_files).toHaveLength(1);
  });
});
