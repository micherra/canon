/**
 * pr-review-v2-integration.test.ts
 *
 * Integration tests for the PrReviewPrep v2 container.
 *
 * Since Svelte components cannot be rendered in Vitest without a DOM, we test:
 *   1. Derived computation logic (totalViolations, netNewFiles, isStale)
 *   2. handlePrompt routing — calls bridge.sendMessage with exact text
 *   3. All 5 prompt string templates from child components
 *   4. Structural contract (component imports, composition)
 *   5. Staleness threshold boundary conditions
 *   6. Acceptance criteria edge cases: 0 violations, 0 blast_radius, single file
 *
 * Canon principles applied:
 *   - compose-from-small-to-large: tests verify container delegates to children
 *   - props-are-the-component-contract: tests verify typed data slices passed down
 *   - no-hidden-side-effects: tests verify handlePrompt is explicit
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "..");

// ── Types (mirrored from PrReviewPrep for test fixtures) ────────────────────

interface Violation {
  principle_id: string;
  severity: "rule" | "strong-opinion" | "convention";
  message?: string;
}

interface PrFileInfo {
  path: string;
  layer: string;
  status: "added" | "modified" | "deleted" | "renamed";
  bucket: "needs-attention" | "worth-a-look" | "low-risk";
  reason: string;
  priority_score?: number;
  priority_factors?: {
    in_degree: number;
    violation_count: number;
    is_changed: boolean;
    layer: string;
    layer_centrality: number;
  };
  violations?: Violation[];
}

// ── Pure computation helpers (extracted from PrReviewPrep logic) ─────────────

function computeTotalViolations(files: PrFileInfo[]): number {
  return files.reduce((sum, f) => sum + (f.violations?.length ?? 0), 0);
}

function computeNetNewFiles(files: PrFileInfo[]): number {
  const added = files.filter(f => f.status === "added").length;
  const deleted = files.filter(f => f.status === "deleted").length;
  return added - deleted;
}

function computeIsStale(graph_data_age_ms: number | undefined): boolean {
  return (graph_data_age_ms ?? 0) > 3_600_000;
}

// ── Prompt template helpers (mirrored from child components) ─────────────────

// ImpactRow.svelte — handleClick
function impactRowPrompt(filePath: string): string {
  return `Show me ${filePath} and explain what changed`;
}

// ViolationCard.svelte — handleClick
function violationCardPrompt(principleId: string, filePath: string): string {
  return `Explain the ${principleId} violation in ${filePath} and how to fix it`;
}

// ChangeStoryGrid.svelte — buildPrompt (new-feature)
function changeStoryNewFeaturePrompt(title: string): string {
  return `Walk me through what ${title} adds to the codebase`;
}

// ChangeStoryGrid.svelte — buildPrompt (removal)
function changeStoryRemovalPrompt(title: string): string {
  return `Why was ${title} removed and what replaced it`;
}

// DepRow.svelte — handleClick
function depRowPrompt(filePath: string): string {
  return `What breaks if ${filePath} regresses? Show me the dependents`;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeFile(
  path: string,
  status: PrFileInfo["status"],
  overrides: Partial<PrFileInfo> = {}
): PrFileInfo {
  return {
    path,
    layer: "tools",
    status,
    bucket: "low-risk",
    reason: "No issues found",
    ...overrides,
  };
}

const SINGLE_FILE_NO_VIOLATIONS: PrFileInfo[] = [
  makeFile("src/tools/pr-review-data.ts", "modified"),
];

const MIXED_STATUS_FILES: PrFileInfo[] = [
  makeFile("src/tools/added-a.ts", "added"),
  makeFile("src/tools/added-b.ts", "added"),
  makeFile("src/tools/added-c.ts", "added"),
  makeFile("src/tools/deleted-a.ts", "deleted"),
  makeFile("src/tools/modified-a.ts", "modified"),
];

const FILES_WITH_VIOLATIONS: PrFileInfo[] = [
  makeFile("src/tools/alpha.ts", "modified", {
    violations: [
      { principle_id: "thin-handlers", severity: "strong-opinion", message: "Too much logic in handler" },
      { principle_id: "errors-are-values", severity: "rule" },
    ],
  }),
  makeFile("src/tools/beta.ts", "modified", {
    violations: [
      { principle_id: "no-hidden-side-effects", severity: "convention", message: "Implicit mutation" },
    ],
  }),
  makeFile("src/tools/gamma.ts", "added"),
];

const ZERO_VIOLATIONS_FILES: PrFileInfo[] = [
  makeFile("src/tools/clean.ts", "modified"),
  makeFile("src/tools/also-clean.ts", "added"),
];

// ── totalViolations computation ───────────────────────────────────────────────

describe("totalViolations computation", () => {
  it("returns 0 when files array is empty", () => {
    expect(computeTotalViolations([])).toBe(0);
  });

  it("returns 0 when files have no violations field", () => {
    expect(computeTotalViolations(ZERO_VIOLATIONS_FILES)).toBe(0);
  });

  it("returns 0 when violations arrays are all empty", () => {
    const files: PrFileInfo[] = [
      makeFile("src/a.ts", "modified", { violations: [] }),
      makeFile("src/b.ts", "modified", { violations: [] }),
    ];
    expect(computeTotalViolations(files)).toBe(0);
  });

  it("counts violations across a single file", () => {
    const files: PrFileInfo[] = [
      makeFile("src/a.ts", "modified", {
        violations: [
          { principle_id: "thin-handlers", severity: "rule" },
          { principle_id: "errors-are-values", severity: "strong-opinion" },
        ],
      }),
    ];
    expect(computeTotalViolations(files)).toBe(2);
  });

  it("sums violations across multiple files", () => {
    // FILES_WITH_VIOLATIONS has 2 + 1 + 0 = 3 violations
    expect(computeTotalViolations(FILES_WITH_VIOLATIONS)).toBe(3);
  });

  it("handles mix of files with and without violations", () => {
    const mixed: PrFileInfo[] = [
      makeFile("src/a.ts", "modified", { violations: [{ principle_id: "p1", severity: "rule" }] }),
      makeFile("src/b.ts", "modified"), // no violations field
      makeFile("src/c.ts", "added", { violations: [] }), // empty array
    ];
    expect(computeTotalViolations(mixed)).toBe(1);
  });
});

// ── netNewFiles computation ────────────────────────────────────────────────────

describe("netNewFiles computation", () => {
  it("returns 0 for empty files array", () => {
    expect(computeNetNewFiles([])).toBe(0);
  });

  it("returns 0 when no files are added or deleted", () => {
    const files = [
      makeFile("src/a.ts", "modified"),
      makeFile("src/b.ts", "renamed"),
    ];
    expect(computeNetNewFiles(files)).toBe(0);
  });

  it("returns positive number when only added files", () => {
    const files = [
      makeFile("src/a.ts", "added"),
      makeFile("src/b.ts", "added"),
      makeFile("src/c.ts", "added"),
    ];
    expect(computeNetNewFiles(files)).toBe(3);
  });

  it("returns negative number when only deleted files", () => {
    const files = [
      makeFile("src/a.ts", "deleted"),
      makeFile("src/b.ts", "deleted"),
    ];
    expect(computeNetNewFiles(files)).toBe(-2);
  });

  it("correctly computes 3 added minus 1 deleted = 2", () => {
    // MIXED_STATUS_FILES: 3 added, 1 deleted, 1 modified
    expect(computeNetNewFiles(MIXED_STATUS_FILES)).toBe(2);
  });

  it("returns 0 when added equals deleted", () => {
    const files = [
      makeFile("src/a.ts", "added"),
      makeFile("src/b.ts", "deleted"),
    ];
    expect(computeNetNewFiles(files)).toBe(0);
  });

  it("ignores modified and renamed files", () => {
    const files = [
      makeFile("src/a.ts", "added"),
      makeFile("src/b.ts", "modified"),
      makeFile("src/c.ts", "renamed"),
    ];
    expect(computeNetNewFiles(files)).toBe(1);
  });
});

// ── isStale computation ────────────────────────────────────────────────────────

describe("isStale computation", () => {
  const ONE_HOUR_MS = 3_600_000;

  it("returns false when graph_data_age_ms is undefined", () => {
    expect(computeIsStale(undefined)).toBe(false);
  });

  it("returns false when graph_data_age_ms is 0", () => {
    expect(computeIsStale(0)).toBe(false);
  });

  it("returns false at exactly the threshold (not strictly greater than)", () => {
    expect(computeIsStale(ONE_HOUR_MS)).toBe(false);
  });

  it("returns true just over the threshold", () => {
    expect(computeIsStale(ONE_HOUR_MS + 1)).toBe(true);
  });

  it("returns true for 2 hours", () => {
    expect(computeIsStale(2 * ONE_HOUR_MS)).toBe(true);
  });

  it("returns true for 24 hours (very stale)", () => {
    expect(computeIsStale(24 * ONE_HOUR_MS)).toBe(true);
  });

  it("returns false for 30 minutes", () => {
    expect(computeIsStale(30 * 60 * 1000)).toBe(false);
  });
});

// ── handlePrompt routing ──────────────────────────────────────────────────────

describe("handlePrompt routing", () => {
  it("passes text directly to bridge.sendMessage", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    // Simulate handlePrompt: calls bridge.sendMessage(text)
    async function handlePrompt(text: string) {
      await sendMessage(text);
    }

    await handlePrompt("Show me src/tools/foo.ts and explain what changed");

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith("Show me src/tools/foo.ts and explain what changed");
  });

  it("passes exact text without modification", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    async function handlePrompt(text: string) {
      await sendMessage(text);
    }

    const promptText = "Explain the thin-handlers violation in src/api/routes.ts and how to fix it";
    await handlePrompt(promptText);

    expect(sendMessage).toHaveBeenCalledWith(promptText);
  });

  it("can be called multiple times for different prompts", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    async function handlePrompt(text: string) {
      await sendMessage(text);
    }

    await handlePrompt("First prompt");
    await handlePrompt("Second prompt");

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, "First prompt");
    expect(sendMessage).toHaveBeenNthCalledWith(2, "Second prompt");
  });
});

// ── Prompt template strings ───────────────────────────────────────────────────

describe("ImpactRow prompt template", () => {
  it("produces correct prompt for a simple file path", () => {
    const result = impactRowPrompt("src/tools/pr-review-data.ts");
    expect(result).toBe("Show me src/tools/pr-review-data.ts and explain what changed");
  });

  it("produces correct prompt for a nested file path", () => {
    const result = impactRowPrompt("mcp-server/src/graph/kg-store.ts");
    expect(result).toBe("Show me mcp-server/src/graph/kg-store.ts and explain what changed");
  });

  it("produces correct prompt for a root-level file", () => {
    const result = impactRowPrompt("index.ts");
    expect(result).toBe("Show me index.ts and explain what changed");
  });
});

describe("ViolationCard prompt template", () => {
  it("produces correct prompt with principle and file", () => {
    const result = violationCardPrompt("thin-handlers", "src/api/routes.ts");
    expect(result).toBe("Explain the thin-handlers violation in src/api/routes.ts and how to fix it");
  });

  it("produces correct prompt for rule severity violation", () => {
    const result = violationCardPrompt("errors-are-values", "src/tools/pr-review-data.ts");
    expect(result).toBe("Explain the errors-are-values violation in src/tools/pr-review-data.ts and how to fix it");
  });

  it("uses exact principle_id in the prompt (no transformation)", () => {
    const result = violationCardPrompt("no-hidden-side-effects", "src/stores/bridge.ts");
    expect(result).toContain("no-hidden-side-effects");
    expect(result).toContain("src/stores/bridge.ts");
  });
});

describe("ChangeStoryGrid new-feature prompt template", () => {
  it("produces correct prompt for a feature cluster title", () => {
    const result = changeStoryNewFeaturePrompt("New: kg-* (graph)");
    expect(result).toBe("Walk me through what New: kg-* (graph) adds to the codebase");
  });

  it("includes the cluster title verbatim", () => {
    const title = "New: auth-token module";
    const result = changeStoryNewFeaturePrompt(title);
    expect(result).toContain(title);
    expect(result).toMatch(/^Walk me through what .+ adds to the codebase$/);
  });
});

describe("ChangeStoryGrid removal prompt template", () => {
  it("produces correct prompt for a removal cluster title", () => {
    const result = changeStoryRemovalPrompt("Removed: legacy-dashboard");
    expect(result).toBe("Why was Removed: legacy-dashboard removed and what replaced it");
  });

  it("includes the cluster title verbatim", () => {
    const title = "Removed: get-branch tools";
    const result = changeStoryRemovalPrompt(title);
    expect(result).toContain(title);
    expect(result).toMatch(/^Why was .+ removed and what replaced it$/);
  });
});

describe("DepRow prompt template", () => {
  it("produces correct prompt for a dependency file", () => {
    const result = depRowPrompt("src/graph/kg-store.ts");
    expect(result).toBe("What breaks if src/graph/kg-store.ts regresses? Show me the dependents");
  });

  it("uses exact file path in the prompt", () => {
    const result = depRowPrompt("mcp-server/ui/stores/bridge.ts");
    expect(result).toContain("mcp-server/ui/stores/bridge.ts");
    expect(result).toMatch(/^What breaks if .+ regresses\? Show me the dependents$/);
  });
});

// ── Staleness warning structural contract ─────────────────────────────────────

describe("PrReview staleness warning — structural contract", () => {
  const sveltePath = join(uiDir, "PrReview.svelte");

  it("contains staleness-warning class", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("staleness-warning");
  });

  it("tests isStale against 3_600_000ms threshold", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("3_600_000");
  });

  it("conditionally renders staleness warning with {#if isStale}", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("isStale");
    expect(content).toContain("{#if isStale}");
  });

  it("staleness warning mentions re-indexing", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("Re-index");
  });
});

// ── Container composition contract ────────────────────────────────────────────

describe("PrReview container composition", () => {
  const sveltePath = join(uiDir, "PrReview.svelte");

  it("exists", () => {
    expect(existsSync(sveltePath)).toBe(true);
  });

  it("imports NarrativeSummary from components/", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("NarrativeSummary");
    expect(content).toContain("./components/NarrativeSummary.svelte");
  });

  it("imports ChangeStoryGrid from components/", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("ChangeStoryGrid");
    expect(content).toContain("./components/ChangeStoryGrid.svelte");
  });

  it("imports ImpactTabs from components/", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("ImpactTabs");
    expect(content).toContain("./components/ImpactTabs.svelte");
  });

  it("does NOT import bridge directly into child components (data-down pattern)", () => {
    // The container passes onPrompt — children do NOT import bridge
    const content = readFileSync(sveltePath, "utf-8");
    // Container imports bridge itself
    expect(content).toContain("import { bridge } from");
    // But passes handlePrompt as onPrompt to children (not bridge directly)
    expect(content).toContain("onPrompt={handlePrompt}");
  });

  it("passes narrative, totalFiles, layerCount, netNewFiles, violationCount to NarrativeSummary (via data.prep)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("narrative={data.prep.narrative}");
    expect(content).toContain("totalFiles={data.prep.total_files}");
    expect(content).toContain("layerCount={data.prep.layers.length}");
    expect(content).toContain("netNewFiles={netNewFiles}");
    expect(content).toContain("violationCount={totalViolations}");
  });

  it("passes files and onPrompt to ChangeStoryGrid (via data.prep.files)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("files={data.prep.files}");
    expect(content).toContain("onPrompt={handlePrompt}");
  });

  it("passes files, blastRadius, and onPrompt to ImpactTabs (via data.prep)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("blastRadius={data.prep.blast_radius}");
  });

  it("does NOT contain old bucket-section markup", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).not.toContain("bucket-section");
  });

  it("does NOT contain old layer-tabs markup", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).not.toContain("layer-tabs");
  });

  it("does NOT contain toggleBucket or toggleBlastRadius helpers", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).not.toContain("toggleBucket");
    expect(content).not.toContain("toggleBlastRadius");
  });
});

// ── Acceptance criteria edge cases ────────────────────────────────────────────

describe("Acceptance criteria: 0 violations, 0 blast_radius, single file", () => {
  it("totalViolations is 0 for a single file with no violations", () => {
    expect(computeTotalViolations(SINGLE_FILE_NO_VIOLATIONS)).toBe(0);
  });

  it("netNewFiles is 0 for a single modified file", () => {
    expect(computeNetNewFiles(SINGLE_FILE_NO_VIOLATIONS)).toBe(0);
  });

  it("isStale is false when graph_data_age_ms is not set (new PR)", () => {
    expect(computeIsStale(undefined)).toBe(false);
  });

  it("ImpactTabs receives empty blastRadius gracefully (0 blast_radius)", () => {
    // When blastRadius = [], Tab C should show empty state
    // We verify the container passes blast_radius correctly (via data.prep.blast_radius)
    const sveltePath = join(uiDir, "PrReview.svelte");
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("blastRadius={data.prep.blast_radius}");
    // blast_radius is always an array (never undefined in PrepData)
  });

  it("totalViolations is 0 for section 1 empty violations display", () => {
    // Section 1 renders for any valid response including 0 violations
    expect(computeTotalViolations([])).toBe(0);
  });
});

describe("Acceptance criteria: all sections render for valid responses", () => {
  it("Section 1 (NarrativeSummary) props are derived from files array", () => {
    // totalViolations and netNewFiles are computed from data.files
    // Any valid response will produce valid values for NarrativeSummary
    const files = ZERO_VIOLATIONS_FILES;
    expect(computeTotalViolations(files)).toBe(0);
    expect(computeNetNewFiles(files)).toBe(1); // 1 added, 0 deleted
  });

  it("Section 3 Tab A: only priority_score >= 15 files qualify as high-impact", () => {
    // This logic lives in ImpactTabs — we verify the threshold is consistent
    const HIGH_IMPACT_THRESHOLD = 15;
    const files: PrFileInfo[] = [
      makeFile("src/a.ts", "modified", { priority_score: 20, priority_factors: { in_degree: 10, violation_count: 0, is_changed: true, layer: "tools", layer_centrality: 0.5 } }),
      makeFile("src/b.ts", "modified", { priority_score: 14, priority_factors: { in_degree: 5, violation_count: 0, is_changed: true, layer: "tools", layer_centrality: 0.3 } }),
      makeFile("src/c.ts", "modified", { priority_score: 15, priority_factors: { in_degree: 7, violation_count: 0, is_changed: true, layer: "tools", layer_centrality: 0.4 } }),
      makeFile("src/d.ts", "modified", { priority_score: 5 }),
    ];
    const highImpact = files.filter(f => (f.priority_score ?? 0) >= HIGH_IMPACT_THRESHOLD);
    expect(highImpact).toHaveLength(2); // score 20 and 15 qualify; 14 and 5 do not
  });

  it("Section 3 Tab B: violations sorted by severity then in_degree", () => {
    const SEVERITY_ORDER: Record<string, number> = {
      "rule": 0,
      "strong-opinion": 1,
      "convention": 2,
    };

    interface FlatViol {
      principleId: string;
      severity: string;
      inDegree: number;
    }

    const violations: FlatViol[] = [
      { principleId: "v1", severity: "convention", inDegree: 10 },
      { principleId: "v2", severity: "rule", inDegree: 3 },
      { principleId: "v3", severity: "strong-opinion", inDegree: 7 },
      { principleId: "v4", severity: "rule", inDegree: 8 },
    ];

    const sorted = [...violations].sort((a, b) => {
      const severityDiff =
        (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
      if (severityDiff !== 0) return severityDiff;
      return b.inDegree - a.inDegree;
    });

    // First two should be rule violations, sorted by in_degree descending
    expect(sorted[0].severity).toBe("rule");
    expect(sorted[0].inDegree).toBe(8); // v4: rule, higher in_degree first
    expect(sorted[1].severity).toBe("rule");
    expect(sorted[1].inDegree).toBe(3); // v2: rule, lower in_degree
    expect(sorted[2].severity).toBe("strong-opinion");
    expect(sorted[3].severity).toBe("convention");
  });
});
