/**
 * prv2-integration-gaps-impact-tabs.test.ts
 *
 * Integration tests and coverage gap fills for the PR Review Context View v2.
 * Part 2 of 2: ImpactTabs, cross-task integration, and bridge guard.
 *
 * This file covers:
 *  10. Coverage gaps declared by prv2-05: ImpactTabs Tab C excludes changed files, "affects N" annotation
 *  11. Coverage gaps declared by prv2-05: ImpactTabs Tab A filter threshold and maxScore normalization
 *  12. Coverage gaps declared by prv2-05: ImpactTabs Tab B severity sort + in_degree tiebreaker
 *  13. Cross-task integration: buildFileViolationMap output → ImpactTabs violation flattening
 *  14. Coverage gaps declared by prv2-03: bridge.sendMessage uninitialized guard
 *
 * Canon principles applied:
 *   - test-the-sad-path: uninitialized bridge, empty inputs, boundary edge cases
 *   - errors-are-values: all error branches verified
 *   - props-are-the-component-contract: component logic tested via extracted pure functions and
 *     structural contracts on .svelte source files (since Svelte runtime is not available in vitest)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "..");

// ── Pure function imports ────────────────────────────────────────────────────

// buildFileViolationMap lives in src/ — import via relative path from ui/__tests__
import { buildFileViolationMap } from "@features/pr-review/tools/pr-review-data-helpers.ts";
import type { ReviewEntry } from "@shared/schema.ts";

// =============================================================================
// Gap #12 — prv2-05 declared gap: ImpactTabs Tab C excludes changed files
// =============================================================================

describe("ImpactTabs Tab C — criticalDeps excludes files in diff (prv2-05 declared gap)", () => {
  // Mirror of the criticalDeps computation in ImpactTabs.svelte
  type ImpactFile = {
    path: string;
    bucket: string;
    violations?: unknown[];
  };
  type BlastEntry = {
    file: string;
    affected: Array<{ path: string; depth: number }>;
  };
  type CriticalDep = {
    path: string;
    changedFileDependents: string[];
  };

  function computeCriticalDeps(files: ImpactFile[], blastRadius: BlastEntry[]): CriticalDep[] {
    const changedFilePaths = new Set(files.map((f) => f.path));
    const depMap = new Map<string, string[]>();

    for (const entry of blastRadius) {
      for (const affected of entry.affected) {
        if (!changedFilePaths.has(affected.path)) {
          const existing = depMap.get(affected.path) ?? [];
          if (!existing.includes(entry.file)) {
            existing.push(entry.file);
          }
          depMap.set(affected.path, existing);
        }
      }
    }

    return [...depMap.entries()].map(([path, dependents]) => ({
      changedFileDependents: dependents,
      path,
    }));
  }

  it("excludes paths that ARE in the diff", () => {
    const files: ImpactFile[] = [
      { bucket: "low-risk", path: "src/a.ts" },
      { bucket: "low-risk", path: "src/b.ts" },
    ];
    const blastRadius: BlastEntry[] = [
      {
        affected: [
          { depth: 1, path: "src/b.ts" }, // in diff — excluded
          { depth: 1, path: "src/external.ts" }, // not in diff — included
        ],
        file: "src/a.ts",
      },
    ];
    const result = computeCriticalDeps(files, blastRadius);
    const paths = result.map((d) => d.path);
    expect(paths).not.toContain("src/b.ts");
    expect(paths).toContain("src/external.ts");
  });

  it("returns empty array when all blast radius affected paths are in the diff", () => {
    const files: ImpactFile[] = [
      { bucket: "low-risk", path: "src/a.ts" },
      { bucket: "low-risk", path: "src/b.ts" },
    ];
    const blastRadius: BlastEntry[] = [
      {
        affected: [{ depth: 1, path: "src/b.ts" }], // in diff
        file: "src/a.ts",
      },
    ];
    expect(computeCriticalDeps(files, blastRadius)).toHaveLength(0);
  });

  it("returns empty array when blastRadius is empty", () => {
    const files: ImpactFile[] = [{ bucket: "low-risk", path: "src/a.ts" }];
    expect(computeCriticalDeps(files, [])).toHaveLength(0);
  });

  it("collects multiple changedFileDependents when a path appears in multiple blast entries", () => {
    const files: ImpactFile[] = [
      { bucket: "low-risk", path: "src/a.ts" },
      { bucket: "low-risk", path: "src/b.ts" },
    ];
    const blastRadius: BlastEntry[] = [
      { affected: [{ depth: 1, path: "src/external.ts" }], file: "src/a.ts" },
      { affected: [{ depth: 1, path: "src/external.ts" }], file: "src/b.ts" },
    ];
    const result = computeCriticalDeps(files, blastRadius);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/external.ts");
    expect(result[0].changedFileDependents).toHaveLength(2);
    expect(result[0].changedFileDependents).toContain("src/a.ts");
    expect(result[0].changedFileDependents).toContain("src/b.ts");
  });

  it("does not duplicate a changedFileDependent when it appears twice for the same affected path", () => {
    const files: ImpactFile[] = [{ bucket: "low-risk", path: "src/a.ts" }];
    const blastRadius: BlastEntry[] = [
      { affected: [{ depth: 1, path: "src/external.ts" }], file: "src/a.ts" },
      { affected: [{ depth: 1, path: "src/external.ts" }], file: "src/a.ts" }, // duplicate
    ];
    const result = computeCriticalDeps(files, blastRadius);
    expect(result[0].changedFileDependents).toHaveLength(1); // deduped
  });
});

// =============================================================================
// Gap #13 — prv2-05 declared gap: ImpactTabs depRiskAnnotation and depRelationship
// =============================================================================

describe("ImpactTabs depRiskAnnotation and depRelationship (prv2-05 declared gap)", () => {
  type CriticalDep = {
    path: string;
    changedFileDependents: string[];
  };

  function depRiskAnnotation(dep: CriticalDep): string | undefined {
    return dep.changedFileDependents.length > 1
      ? `affects ${dep.changedFileDependents.length} changed files`
      : undefined;
  }

  function depRelationship(dep: CriticalDep): string {
    const count = dep.changedFileDependents.length;
    if (count === 1) {
      const dependent = dep.changedFileDependents[0];
      const name = dependent.split("/").pop() ?? dependent;
      return `used by ${name}`;
    }
    return `used by ${count} changed files`;
  }

  it("depRiskAnnotation returns undefined for exactly 1 dependent", () => {
    expect(
      depRiskAnnotation({ changedFileDependents: ["src/a.ts"], path: "src/x.ts" }),
    ).toBeUndefined();
  });

  it("depRiskAnnotation returns 'affects 2 changed files' for 2 dependents", () => {
    expect(
      depRiskAnnotation({ changedFileDependents: ["src/a.ts", "src/b.ts"], path: "src/x.ts" }),
    ).toBe("affects 2 changed files");
  });

  it("depRiskAnnotation returns 'affects 3 changed files' for 3 dependents", () => {
    expect(
      depRiskAnnotation({
        changedFileDependents: ["src/a.ts", "src/b.ts", "src/c.ts"],
        path: "src/x.ts",
      }),
    ).toBe("affects 3 changed files");
  });

  it("depRelationship uses filename (not full path) for a single dependent", () => {
    expect(
      depRelationship({
        changedFileDependents: ["src/graph/kg-store.ts"],
        path: "src/x.ts",
      }),
    ).toBe("used by kg-store.ts");
  });

  it("depRelationship uses count summary for multiple dependents", () => {
    expect(
      depRelationship({
        changedFileDependents: ["src/a.ts", "src/b.ts"],
        path: "src/x.ts",
      }),
    ).toBe("used by 2 changed files");
  });

  it("ImpactTabs.svelte source contains the 'affects N changed files' annotation pattern", () => {
    const path = join(uiDir, "components/ImpactTabs.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("affects");
    expect(content).toContain("changed files");
  });
});

// =============================================================================
// Gap #14 — prv2-05 declared gap: ImpactTabs Tab A filter threshold and maxScore normalization
// =============================================================================

describe("ImpactTabs Tab A — highImpactFiles filter and maxScore (prv2-05 declared gap)", () => {
  type ImpactFile = {
    path: string;
    priority_score?: number;
    bucket: string;
  };

  function computeHighImpact(files: ImpactFile[]): ImpactFile[] {
    return files
      .filter((f) => (f.priority_score ?? 0) >= 15)
      .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
  }

  it("includes files with priority_score exactly 15 (boundary — inclusive)", () => {
    const files: ImpactFile[] = [
      { bucket: "needs-attention", path: "src/a.ts", priority_score: 15 },
    ];
    expect(computeHighImpact(files)).toHaveLength(1);
  });

  it("excludes files with priority_score of 14 (just below threshold)", () => {
    const files: ImpactFile[] = [
      { bucket: "needs-attention", path: "src/a.ts", priority_score: 14 },
    ];
    expect(computeHighImpact(files)).toHaveLength(0);
  });

  it("excludes files with undefined priority_score (treated as 0)", () => {
    const files: ImpactFile[] = [{ bucket: "low-risk", path: "src/a.ts" }];
    expect(computeHighImpact(files)).toHaveLength(0);
  });

  it("sorts results by priority_score descending", () => {
    const files: ImpactFile[] = [
      { bucket: "needs-attention", path: "src/a.ts", priority_score: 15 },
      { bucket: "needs-attention", path: "src/b.ts", priority_score: 30 },
      { bucket: "needs-attention", path: "src/c.ts", priority_score: 22 },
    ];
    const result = computeHighImpact(files);
    expect(result[0].priority_score).toBe(30);
    expect(result[1].priority_score).toBe(22);
    expect(result[2].priority_score).toBe(15);
  });

  it("maxScore derived value equals highest priority_score in high-impact set", () => {
    const files: ImpactFile[] = [
      { bucket: "needs-attention", path: "src/a.ts", priority_score: 15 },
      { bucket: "needs-attention", path: "src/b.ts", priority_score: 30 },
    ];
    const highImpact = computeHighImpact(files);
    const maxScore =
      highImpact.length > 0 ? Math.max(...highImpact.map((f) => f.priority_score ?? 0)) : 1;
    expect(maxScore).toBe(30);
  });

  it("highest score file gets 100% bar width via maxScore normalization", () => {
    const files: ImpactFile[] = [
      { bucket: "needs-attention", path: "src/a.ts", priority_score: 15 },
      { bucket: "needs-attention", path: "src/b.ts", priority_score: 30 },
    ];
    const highImpact = computeHighImpact(files);
    const maxScore = Math.max(...highImpact.map((f) => f.priority_score ?? 0));
    const widthForTop = Math.min(100, Math.round((30 / maxScore) * 100));
    expect(widthForTop).toBe(100);
  });

  it("ImpactTabs.svelte source contains the >= 15 threshold literal", () => {
    const path = join(uiDir, "components/ImpactTabs.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain(">= 15");
  });

  it("ImpactTabs.svelte empty state for Tab A is 'No high-impact files in this PR'", () => {
    const path = join(uiDir, "components/ImpactTabs.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("No high-impact files in this PR");
  });
});

// =============================================================================
// Gap #15 — prv2-05 declared gap: ImpactTabs Tab B severity sort + in_degree tiebreaker
// =============================================================================

describe("ImpactTabs Tab B — violation sort order (prv2-05 declared gap)", () => {
  type FlatViolation = {
    filePath: string;
    inDegree: number;
    violation: { principle_id: string; severity: "rule" | "strong-opinion" | "convention" };
  };

  const SEVERITY_ORDER: Record<string, number> = {
    convention: 2,
    rule: 0,
    "strong-opinion": 1,
  };

  function sortViolations(violations: FlatViolation[]): FlatViolation[] {
    return [...violations].sort((a, b) => {
      const severityDiff =
        (SEVERITY_ORDER[a.violation.severity] ?? 99) - (SEVERITY_ORDER[b.violation.severity] ?? 99);
      if (severityDiff !== 0) return severityDiff;
      return b.inDegree - a.inDegree;
    });
  }

  it("rule violations sort before strong-opinion", () => {
    const violations: FlatViolation[] = [
      {
        filePath: "src/a.ts",
        inDegree: 3,
        violation: { principle_id: "p1", severity: "strong-opinion" },
      },
      { filePath: "src/b.ts", inDegree: 3, violation: { principle_id: "p2", severity: "rule" } },
    ];
    const sorted = sortViolations(violations);
    expect(sorted[0].violation.severity).toBe("rule");
    expect(sorted[1].violation.severity).toBe("strong-opinion");
  });

  it("strong-opinion violations sort before convention", () => {
    const violations: FlatViolation[] = [
      {
        filePath: "src/a.ts",
        inDegree: 3,
        violation: { principle_id: "p1", severity: "convention" },
      },
      {
        filePath: "src/b.ts",
        inDegree: 3,
        violation: { principle_id: "p2", severity: "strong-opinion" },
      },
    ];
    const sorted = sortViolations(violations);
    expect(sorted[0].violation.severity).toBe("strong-opinion");
    expect(sorted[1].violation.severity).toBe("convention");
  });

  it("full severity order: rule → strong-opinion → convention", () => {
    const violations: FlatViolation[] = [
      {
        filePath: "src/a.ts",
        inDegree: 0,
        violation: { principle_id: "p1", severity: "convention" },
      },
      { filePath: "src/b.ts", inDegree: 0, violation: { principle_id: "p2", severity: "rule" } },
      {
        filePath: "src/c.ts",
        inDegree: 0,
        violation: { principle_id: "p3", severity: "strong-opinion" },
      },
    ];
    const sorted = sortViolations(violations);
    expect(sorted[0].violation.severity).toBe("rule");
    expect(sorted[1].violation.severity).toBe("strong-opinion");
    expect(sorted[2].violation.severity).toBe("convention");
  });

  it("in_degree tiebreaker: higher in_degree sorts first within same severity", () => {
    const violations: FlatViolation[] = [
      { filePath: "src/a.ts", inDegree: 3, violation: { principle_id: "p1", severity: "rule" } },
      { filePath: "src/b.ts", inDegree: 8, violation: { principle_id: "p2", severity: "rule" } },
      { filePath: "src/c.ts", inDegree: 1, violation: { principle_id: "p3", severity: "rule" } },
    ];
    const sorted = sortViolations(violations);
    expect(sorted[0].inDegree).toBe(8);
    expect(sorted[1].inDegree).toBe(3);
    expect(sorted[2].inDegree).toBe(1);
  });

  it("violations with same severity and same in_degree are not lost", () => {
    const violations: FlatViolation[] = [
      {
        filePath: "src/a.ts",
        inDegree: 5,
        violation: { principle_id: "p1", severity: "convention" },
      },
      {
        filePath: "src/b.ts",
        inDegree: 5,
        violation: { principle_id: "p2", severity: "convention" },
      },
    ];
    const sorted = sortViolations(violations);
    expect(sorted).toHaveLength(2);
  });

  it("ImpactTabs.svelte source contains SEVERITY_ORDER with all three levels", () => {
    const path = join(uiDir, "components/ImpactTabs.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("SEVERITY_ORDER");
    expect(content).toContain("rule: 0");
    expect(content).toContain('"strong-opinion": 1');
    expect(content).toContain("convention: 2");
  });

  it("ImpactTabs.svelte empty state for Tab B is 'No violations found'", () => {
    const path = join(uiDir, "components/ImpactTabs.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("No violations found");
  });
});

// =============================================================================
// Gap #16 — Cross-task integration: buildFileViolationMap output → ImpactTabs flattening
// =============================================================================

describe("Cross-task: buildFileViolationMap → ImpactTabs violation flattening (prv2-01 × prv2-05)", () => {
  it("buildFileViolationMap output correctly populates per-file violations for ImpactTabs", () => {
    const reviews: ReviewEntry[] = [
      {
        files: ["src/a.ts"],
        honored: [],
        review_id: "rev_cross_1",
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 1 },
          rules: { passed: 0, total: 1 },
        },
        timestamp: "2026-03-25T10:00:00Z",
        verdict: "BLOCKING",
        violations: [
          { file_path: "src/a.ts", principle_id: "thin-handlers", severity: "strong-opinion" },
          { file_path: "src/b.ts", principle_id: "errors-are-values", severity: "rule" },
        ],
      },
    ];

    const violationMap = buildFileViolationMap(reviews);

    // Simulate getPrReviewData: attach violations to PrFileInfo entries
    const files = [
      { path: "src/a.ts", violations: violationMap.get("src/a.ts") ?? [] },
      { path: "src/b.ts", violations: violationMap.get("src/b.ts") ?? [] },
      { path: "src/c.ts", violations: violationMap.get("src/c.ts") ?? [] }, // no violations
    ];

    // Simulate ImpactTabs flatMap
    const flatViolations = files.flatMap((f) =>
      (f.violations ?? []).map((v) => ({
        filePath: f.path,
        inDegree: 0,
        violation: v,
      })),
    );

    expect(flatViolations).toHaveLength(2); // one from a.ts, one from b.ts
    expect(flatViolations[0].filePath).toBe("src/a.ts");
    expect(flatViolations[0].violation.principle_id).toBe("thin-handlers");
    expect(flatViolations[1].filePath).toBe("src/b.ts");
    expect(flatViolations[1].violation.principle_id).toBe("errors-are-values");
  });

  it("empty reviews produce zero violations in the ImpactTabs flat list", () => {
    const violationMap = buildFileViolationMap([]);

    const files = [
      { path: "src/a.ts", violations: violationMap.get("src/a.ts") ?? [] },
      { path: "src/b.ts", violations: violationMap.get("src/b.ts") ?? [] },
    ];

    const flatViolations = files.flatMap((f) =>
      (f.violations ?? []).map((v) => ({ filePath: f.path, inDegree: 0, violation: v })),
    );

    expect(flatViolations).toHaveLength(0);
  });

  it("accumulated violations across multiple reviews appear in the flat list", () => {
    const reviews: ReviewEntry[] = [
      {
        files: ["src/shared.ts"],
        honored: [],
        review_id: "rev_a",
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 1 },
        },
        timestamp: "2026-03-24T10:00:00Z",
        verdict: "BLOCKING",
        violations: [{ file_path: "src/shared.ts", principle_id: "p-rule", severity: "rule" }],
      },
      {
        files: ["src/shared.ts"],
        honored: [],
        review_id: "rev_b",
        score: {
          conventions: { passed: 0, total: 1 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 0 },
        },
        timestamp: "2026-03-25T10:00:00Z",
        verdict: "WARNING",
        violations: [
          { file_path: "src/shared.ts", principle_id: "p-convention", severity: "convention" },
        ],
      },
    ];

    const violationMap = buildFileViolationMap(reviews);
    const sharedViolations = violationMap.get("src/shared.ts") ?? [];

    // Simulate ImpactTabs flattening for this one file
    const flatViolations = sharedViolations.map((v) => ({
      filePath: "src/shared.ts",
      inDegree: 0,
      violation: v,
    }));

    expect(flatViolations).toHaveLength(2);
    const principles = flatViolations.map((v) => v.violation.principle_id);
    expect(principles).toContain("p-rule");
    expect(principles).toContain("p-convention");
  });
});

// =============================================================================
// Gap #17 — prv2-03: bridge.sendMessage uninitialized guard (fresh module scope)
// =============================================================================

describe("bridge.sendMessage() — uninitialized guard (prv2-03 declared gap)", () => {
  it("throws 'Bridge not initialized' when sendMessage is called before init()", async () => {
    // Reset module registry to get a fresh bridge with app = null
    vi.resetModules();

    const mockSendMessage = vi.fn();
    const mockConnect = vi.fn().mockResolvedValue(undefined);
    const mockGetHostContext = vi.fn().mockReturnValue(null);

    class MockApp {
      constructor(
        public _info: unknown,
        public _caps: unknown,
        public _opts: unknown,
      ) {}
      connect = mockConnect;
      getHostContext = mockGetHostContext;
      callServerTool = vi.fn();
      sendMessage = mockSendMessage;
      set onhostcontextchanged(_cb: unknown) {
        /* noop */
      }
      set ontoolresult(_cb: unknown) {
        /* noop */
      }
      set onerror(_cb: unknown) {
        /* noop */
      }
    }

    vi.doMock("@modelcontextprotocol/ext-apps", () => ({
      App: MockApp,
      applyDocumentTheme: vi.fn(),
      applyHostFonts: vi.fn(),
      applyHostStyleVariables: vi.fn(),
    }));

    // Import bridge AFTER vi.resetModules() but BEFORE calling init() — app stays null
    const { bridge: freshBridge } = await import("../stores/bridge.js");

    // sendMessage without init should throw the guard error
    await expect(freshBridge.sendMessage("hello")).rejects.toThrow("Bridge not initialized");

    vi.restoreAllMocks();
  });
});
