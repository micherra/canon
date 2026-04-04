/**
 * prv2-integration-gaps.test.ts
 *
 * Integration tests and coverage gap fills for the PR Review Context View v2.
 *
 * This file covers:
 *   1. Cross-task integration: buildFileViolationMap output → ImpactTabs violation flattening
 *   2. Cross-task integration: clusterFiles output → ChangeStoryGrid buildPrompt default case
 *   3. Cross-task integration: SEVERITY_COLORS contract → ViolationCard color values
 *   4. Coverage gaps declared by prv2-02: clusterIcon(), renamed status, synthesizeDescription exact strings
 *   5. Coverage gaps declared by prv2-03: bridge.sendMessage uninitialized guard
 *   6. Coverage gaps declared by prv2-04: ImpactRow score bar color thresholds (boundary values)
 *   7. Coverage gaps declared by prv2-04: NarrativeSummary structural contracts (+/- netNewFiles, danger)
 *   8. Coverage gaps declared by prv2-04: ViolationCard description fallback, severity pill labels
 *   9. Coverage gaps declared by prv2-04: DepRow riskAnnotation conditional render
 *  10. Coverage gaps declared by prv2-05: ImpactTabs Tab C excludes changed files, "affects N" annotation
 *  11. Coverage gaps declared by prv2-05: ChangeStoryGrid default prompt template
 *  12. Coverage gaps declared by prv2-05: ChangeStoryGrid "+N more" chip logic
 *  13. Coverage gaps declared by prv2-05: ImpactTabs Tab A filter threshold and maxScore normalization
 *  14. Coverage gaps declared by prv2-05: ImpactTabs Tab B severity sort + in_degree tiebreaker
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

import type { ReviewEntry } from "../../schema.ts";
// buildFileViolationMap lives in src/ — import via relative path from ui/__tests__
import { buildFileViolationMap } from "../../tools/pr-review-data.ts";
import {
  type Cluster,
  type ClusterInput,
  clusterFiles,
  clusterIcon,
  synthesizeDescription,
} from "../lib/clustering.ts";
import { SEVERITY_COLORS } from "../lib/constants.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeClusterInput(
  path: string,
  status: ClusterInput["status"],
  layer: string,
): ClusterInput {
  return { path, status, layer };
}

// =============================================================================
// Gap #1 — prv2-02: clusterIcon() direct tests (declared known gap)
// =============================================================================

describe("clusterIcon() — direct unit tests (prv2-02 declared gap)", () => {
  it("returns ✓ for new-feature", () => {
    expect(clusterIcon("new-feature")).toBe("✓");
  });

  it("returns ✗ for removal", () => {
    expect(clusterIcon("removal")).toBe("✗");
  });

  it("returns ⏱ for prefix-group", () => {
    expect(clusterIcon("prefix-group")).toBe("⏱");
  });

  it("returns ⚠ for layer-group", () => {
    expect(clusterIcon("layer-group")).toBe("⚠");
  });

  it("returns ⚠ for other", () => {
    expect(clusterIcon("other")).toBe("⚠");
  });

  it("all 5 cluster types return a non-empty string", () => {
    const types: Cluster["type"][] = [
      "new-feature",
      "removal",
      "prefix-group",
      "layer-group",
      "other",
    ];
    for (const type of types) {
      expect(clusterIcon(type).length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Gap #2 — prv2-02: synthesizeDescription exact string content
// =============================================================================

describe("synthesizeDescription() — exact string content (prv2-02 declared gap)", () => {
  it("returns 'No files.' for empty array", () => {
    expect(synthesizeDescription([])).toBe("No files.");
  });

  it("counts added files correctly in the string", () => {
    const files = [
      makeClusterInput("src/a.ts", "added", "tools"),
      makeClusterInput("src/b.ts", "added", "tools"),
    ];
    const result = synthesizeDescription(files);
    expect(result).toContain("2 files added");
  });

  it("counts modified files correctly; renamed counts as modified", () => {
    const files = [
      makeClusterInput("src/a.ts", "modified", "tools"),
      makeClusterInput("src/b.ts", "renamed", "tools"),
    ];
    const result = synthesizeDescription(files);
    expect(result).toContain("2 files modified");
  });

  it("counts deleted files correctly (1 file deleted)", () => {
    const files = [makeClusterInput("src/a.ts", "deleted", "tools")];
    const result = synthesizeDescription(files);
    expect(result).toContain("1 file deleted");
  });

  it("includes all three counts when mixed statuses", () => {
    const files = [
      makeClusterInput("src/a.ts", "added", "tools"),
      makeClusterInput("src/b.ts", "modified", "tools"),
      makeClusterInput("src/c.ts", "deleted", "tools"),
    ];
    const result = synthesizeDescription(files);
    expect(result).toContain("1 file added");
    expect(result).toContain("1 file modified");
    expect(result).toContain("1 file deleted");
  });

  it("includes 'Includes:' with sample basenames (strips extension)", () => {
    const files = [
      makeClusterInput("src/graph/kg-store.ts", "modified", "graph"),
      makeClusterInput("src/graph/kg-query.ts", "modified", "graph"),
    ];
    const result = synthesizeDescription(files);
    expect(result).toContain("Includes:");
    expect(result).toContain("kg-store");
    expect(result).toContain("kg-query");
  });

  it("appends ', and more' when more than 3 files in the description sample", () => {
    const files = [
      makeClusterInput("src/a.ts", "added", "tools"),
      makeClusterInput("src/b.ts", "added", "tools"),
      makeClusterInput("src/c.ts", "added", "tools"),
      makeClusterInput("src/d.ts", "added", "tools"),
    ];
    const result = synthesizeDescription(files);
    expect(result).toContain("and more");
  });

  it("does NOT append ', and more' for exactly 3 files", () => {
    const files = [
      makeClusterInput("src/a.ts", "added", "tools"),
      makeClusterInput("src/b.ts", "added", "tools"),
      makeClusterInput("src/c.ts", "added", "tools"),
    ];
    const result = synthesizeDescription(files);
    expect(result).not.toContain("and more");
  });

  it("uses singular 'file added' for exactly 1 file added", () => {
    const files = [makeClusterInput("src/a.ts", "added", "tools")];
    const result = synthesizeDescription(files);
    expect(result).toContain("1 file added");
    expect(result).not.toContain("1 files added");
  });
});

// =============================================================================
// Gap #3 — prv2-02: renamed status files in clustering (declared known gap)
// =============================================================================

describe("clusterFiles() — renamed status handling (prv2-02 declared gap)", () => {
  it("renamed files do NOT create new-feature clusters", () => {
    const files = [
      makeClusterInput("src/tools/old-a.ts", "renamed", "tools"),
      makeClusterInput("src/tools/old-b.ts", "renamed", "tools"),
    ];
    const result = clusterFiles(files);
    const newFeature = result.find((c) => c.type === "new-feature");
    expect(newFeature).toBeUndefined();
  });

  it("renamed files do NOT create removal clusters", () => {
    const files = [
      makeClusterInput("src/tools/old-a.ts", "renamed", "tools"),
      makeClusterInput("src/tools/old-b.ts", "renamed", "tools"),
    ];
    const result = clusterFiles(files);
    const removal = result.find((c) => c.type === "removal");
    expect(removal).toBeUndefined();
  });

  it("renamed files participate in prefix grouping when they share a prefix", () => {
    const files = [
      makeClusterInput("src/graph/kg-store.ts", "renamed", "graph"),
      makeClusterInput("src/graph/kg-query.ts", "renamed", "graph"),
    ];
    const result = clusterFiles(files);
    // Must not be empty and must not be new-feature/removal
    expect(result.length).toBeGreaterThan(0);
    const types = result.map((c) => c.type);
    expect(types).not.toContain("new-feature");
    expect(types).not.toContain("removal");
  });

  it("all files with renamed status are accounted for in output clusters", () => {
    const files = [
      makeClusterInput("src/a/moved.ts", "renamed", "tools"),
      makeClusterInput("src/b/other.ts", "modified", "tools"),
    ];
    const result = clusterFiles(files);
    const total = result.reduce((sum, c) => sum + c.files.length, 0);
    expect(total).toBe(files.length);
  });

  it("synthesizeDescription counts renamed files in the modified count", () => {
    const files = [
      makeClusterInput("src/a.ts", "renamed", "tools"),
      makeClusterInput("src/b.ts", "modified", "tools"),
    ];
    // renamed and modified are both counted as "modified" in synthesizeDescription
    const desc = synthesizeDescription(files);
    expect(desc).toContain("2 files modified");
  });
});

// =============================================================================
// Gap #4 — Cross-task: clusterFiles output → ChangeStoryGrid buildPrompt default case
// =============================================================================

describe("ChangeStoryGrid buildPrompt — default case (prv2-05 declared gap / prv2-02 cross-task)", () => {
  // Mirror of the buildPrompt function in ChangeStoryGrid.svelte
  function buildPrompt(cluster: Cluster): string {
    switch (cluster.type) {
      case "new-feature":
        return `Walk me through what ${cluster.title} adds to the codebase`;
      case "removal":
        return `Why was ${cluster.title} removed and what replaced it`;
      default:
        return `Explain the changes in ${cluster.title}`;
    }
  }

  it("prefix-group clusters produce the 'Explain the changes' default prompt", () => {
    const files = [
      makeClusterInput("src/graph/kg-store.ts", "modified", "graph"),
      makeClusterInput("src/graph/kg-query.ts", "modified", "graph"),
      makeClusterInput("src/graph/kg-types.ts", "modified", "graph"),
    ];
    const clusters = clusterFiles(files);
    const prefixGroup = clusters.find((c) => c.type === "prefix-group");
    expect(prefixGroup).toBeDefined();
    const prompt = buildPrompt(prefixGroup!);
    expect(prompt).toMatch(/^Explain the changes in .+$/);
    expect(prompt).toContain(prefixGroup!.title);
  });

  it("other clusters produce the 'Explain the changes' default prompt", () => {
    const cluster: Cluster = {
      id: "other-modifications",
      title: "Other modifications",
      type: "other",
      description: "1 file modified. Includes: lone-file.",
      files: [makeClusterInput("src/tools/lone-file.ts", "modified", "tools")],
    };
    expect(buildPrompt(cluster)).toBe("Explain the changes in Other modifications");
  });

  it("layer-group clusters produce the 'Explain the changes' default prompt", () => {
    const cluster: Cluster = {
      id: "layer-tools",
      title: "tools changes",
      type: "layer-group",
      description: "2 files modified.",
      files: [
        makeClusterInput("src/a/foo.ts", "modified", "tools"),
        makeClusterInput("src/b/bar.ts", "modified", "tools"),
      ],
    };
    expect(buildPrompt(cluster)).toBe("Explain the changes in tools changes");
  });

  it("new-feature prompt is distinct from the default", () => {
    const cluster: Cluster = {
      id: "new-feature-xyz",
      title: "New: auth-module",
      type: "new-feature",
      description: "2 files added.",
      files: [],
    };
    const prompt = buildPrompt(cluster);
    expect(prompt).not.toMatch(/^Explain the changes/);
    expect(prompt).toMatch(/^Walk me through what/);
  });

  it("ChangeStoryGrid.svelte contains the default 'Explain the changes' prompt template", () => {
    const path = join(uiDir, "components/ChangeStoryGrid.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("Explain the changes in");
    expect(content).toContain("default:");
  });
});

// =============================================================================
// Gap #5 — prv2-05 declared gap: ChangeStoryGrid "+N more" chip logic
// =============================================================================

describe("ChangeStoryGrid '+N more' chip logic (prv2-05 declared gap)", () => {
  it("ChangeStoryGrid.svelte renders up to 5 file chips via slice(0, 5)", () => {
    const path = join(uiDir, "components/ChangeStoryGrid.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("slice(0, 5)");
  });

  it("ChangeStoryGrid.svelte shows '+N more' chip when cluster.files.length > 5", () => {
    const path = join(uiDir, "components/ChangeStoryGrid.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("cluster.files.length > 5");
    expect(content).toContain("chip-more");
    expect(content).toContain("cluster.files.length - 5");
  });

  it("clusterFiles produces a cluster with > 5 files for an 8-file kg- group", () => {
    const files: ClusterInput[] = [];
    for (let i = 0; i < 8; i++) {
      files.push(makeClusterInput(`src/graph/kg-file${i}.ts`, "modified", "graph"));
    }
    const clusters = clusterFiles(files);
    const hasLargeCluster = clusters.some((c) => c.files.length > 5);
    expect(hasLargeCluster).toBe(true);
  });

  it("ChangeStoryGrid.svelte empty state message is 'No change stories to display'", () => {
    const path = join(uiDir, "components/ChangeStoryGrid.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("No change stories to display");
  });

  it("ChangeStoryGrid.svelte empty state is guarded by clusters.length === 0", () => {
    const path = join(uiDir, "components/ChangeStoryGrid.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("clusters.length === 0");
  });
});

// =============================================================================
// Gap #6 — prv2-04 declared gap: ImpactRow score bar color thresholds (boundary values)
// =============================================================================

describe("ImpactRow score bar color logic — boundary values (prv2-04 declared gap)", () => {
  // Mirror of the barColor $derived in ImpactRow.svelte
  function barColor(priorityScore: number): string {
    return priorityScore >= 20
      ? "var(--danger, #ff6b6b)"
      : priorityScore >= 10
        ? "var(--warning, #fbbf24)"
        : "var(--accent, #6c8cff)";
  }

  it("score of 20 returns danger color (>= 20 threshold)", () => {
    expect(barColor(20)).toBe("var(--danger, #ff6b6b)");
  });

  it("score of 19 returns warning color (just below danger threshold)", () => {
    expect(barColor(19)).toBe("var(--warning, #fbbf24)");
  });

  it("score of 10 returns warning color (>= 10 threshold)", () => {
    expect(barColor(10)).toBe("var(--warning, #fbbf24)");
  });

  it("score of 9 returns accent color (just below warning threshold)", () => {
    expect(barColor(9)).toBe("var(--accent, #6c8cff)");
  });

  it("score of 0 returns accent color (minimum)", () => {
    expect(barColor(0)).toBe("var(--accent, #6c8cff)");
  });

  it("score of 100 returns danger color (well above danger threshold)", () => {
    expect(barColor(100)).toBe("var(--danger, #ff6b6b)");
  });

  it("ImpactRow.svelte source contains threshold literals >= 20 and >= 10", () => {
    const path = join(uiDir, "components/ImpactRow.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain(">= 20");
    expect(content).toContain(">= 10");
  });
});

// =============================================================================
// Gap #7 — prv2-04 declared gap: ImpactRow bar width clamping
// =============================================================================

describe("ImpactRow bar width calculation (prv2-04 declared gap)", () => {
  // Mirror of barWidth $derived in ImpactRow.svelte
  function barWidth(priorityScore: number, maxScore: number): number {
    return maxScore > 0 ? Math.min(100, Math.round((priorityScore / maxScore) * 100)) : 0;
  }

  it("returns 0 when maxScore is 0 (prevents divide-by-zero)", () => {
    expect(barWidth(10, 0)).toBe(0);
  });

  it("returns 100 when priorityScore equals maxScore", () => {
    expect(barWidth(30, 30)).toBe(100);
  });

  it("returns 50 for half the max score", () => {
    expect(barWidth(15, 30)).toBe(50);
  });

  it("clamps to 100 when priorityScore exceeds maxScore", () => {
    expect(barWidth(35, 30)).toBe(100);
  });

  it("returns 0 for a priority score of 0", () => {
    expect(barWidth(0, 30)).toBe(0);
  });
});

// =============================================================================
// Gap #8 — prv2-04 declared gap: NarrativeSummary netNewFiles +/- formatting
// =============================================================================

describe("NarrativeSummary netNewFiles display logic (prv2-04 declared gap)", () => {
  it("NarrativeSummary.svelte renders '+' prefix for positive netNewFiles", () => {
    const path = join(uiDir, "components/NarrativeSummary.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('netNewFiles > 0 ? "+" : ""');
  });

  it("NarrativeSummary.svelte applies 'positive' CSS class when netNewFiles > 0", () => {
    const path = join(uiDir, "components/NarrativeSummary.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("positive={netNewFiles > 0}");
  });

  it("NarrativeSummary.svelte applies 'negative' CSS class when netNewFiles < 0", () => {
    const path = join(uiDir, "components/NarrativeSummary.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("negative={netNewFiles < 0}");
  });

  it("NarrativeSummary.svelte applies 'danger' CSS class when violationCount > 0", () => {
    const path = join(uiDir, "components/NarrativeSummary.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("danger={violationCount > 0}");
  });

  it("NarrativeSummary.svelte sublabel pluralizes layers correctly (layer vs layers)", () => {
    const path = join(uiDir, "components/NarrativeSummary.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('layerCount === 1 ? "" : "s"');
  });
});

// =============================================================================
// Gap #9 — prv2-04 declared gap: ViolationCard description fallback + severity labels
// =============================================================================

describe("ViolationCard description fallback and severity labels (prv2-04 declared gap)", () => {
  it("ViolationCard.svelte falls back to 'Principle violation' when description is absent", () => {
    const path = join(uiDir, "components/ViolationCard.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('"Principle violation"');
    expect(content).toContain("description ??");
  });

  it("ViolationCard.svelte human label for 'rule' severity is 'Rule'", () => {
    const path = join(uiDir, "components/ViolationCard.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('"Rule"');
  });

  it("ViolationCard.svelte human label for 'strong-opinion' severity is 'Opinion'", () => {
    const path = join(uiDir, "components/ViolationCard.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('"Opinion"');
  });

  it("ViolationCard.svelte human label for 'convention' severity is 'Convention'", () => {
    const path = join(uiDir, "components/ViolationCard.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('"Convention"');
  });

  it("ViolationCard.svelte click handler fires the exact prompt string", () => {
    const path = join(uiDir, "components/ViolationCard.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("Explain the");
    expect(content).toContain("violation in");
    expect(content).toContain("and how to fix it");
  });
});

// =============================================================================
// Gap #10 — Cross-task: SEVERITY_COLORS contract → ViolationCard color values
// =============================================================================

describe("SEVERITY_COLORS contract (cross-task: constants → ViolationCard)", () => {
  it("rule severity maps to a red-family hex color (#e74c3c)", () => {
    expect(SEVERITY_COLORS["rule"]).toBe("#e74c3c");
  });

  it("strong-opinion severity maps to an orange-family hex color (#f39c12)", () => {
    expect(SEVERITY_COLORS["strong-opinion"]).toBe("#f39c12");
  });

  it("convention severity maps to a blue-family hex color (#3498db)", () => {
    expect(SEVERITY_COLORS["convention"]).toBe("#3498db");
  });

  it("rule color is distinct from strong-opinion color", () => {
    expect(SEVERITY_COLORS["rule"]).not.toBe(SEVERITY_COLORS["strong-opinion"]);
  });

  it("strong-opinion color is distinct from convention color", () => {
    expect(SEVERITY_COLORS["strong-opinion"]).not.toBe(SEVERITY_COLORS["convention"]);
  });

  it("all three severity types are present in SEVERITY_COLORS", () => {
    expect(SEVERITY_COLORS).toHaveProperty("rule");
    expect(SEVERITY_COLORS).toHaveProperty("strong-opinion");
    expect(SEVERITY_COLORS).toHaveProperty("convention");
  });

  it("ViolationCard.svelte uses getSeverityColor from lib/utils for the severity pill color", () => {
    const path = join(uiDir, "components/ViolationCard.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("getSeverityColor");
    expect(content).toContain("../lib/utils");
  });

  it("ViolationCard.svelte passes severity to getSeverityColor for the severity pill color", () => {
    const path = join(uiDir, "components/ViolationCard.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("getSeverityColor(severity)");
  });
});

// =============================================================================
// Gap #11 — prv2-04 declared gap: DepRow riskAnnotation conditional render
// =============================================================================

describe("DepRow riskAnnotation conditional render (prv2-04 declared gap)", () => {
  it("DepRow.svelte conditionally renders risk-annotation element only when riskAnnotation is truthy", () => {
    const path = join(uiDir, "components/DepRow.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("{#if riskAnnotation}");
    expect(content).toContain("risk-annotation");
  });

  it("DepRow.svelte declares riskAnnotation as an optional prop (trailing ?)", () => {
    const path = join(uiDir, "components/DepRow.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("riskAnnotation?");
  });

  it("DepRow.svelte click handler fires the correct 'What breaks if' prompt", () => {
    const path = join(uiDir, "components/DepRow.svelte");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("What breaks if");
    expect(content).toContain("regresses? Show me the dependents");
    expect(content).toContain("filePath");
  });
});

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
      path,
      changedFileDependents: dependents,
    }));
  }

  it("excludes paths that ARE in the diff", () => {
    const files: ImpactFile[] = [
      { path: "src/a.ts", bucket: "low-risk" },
      { path: "src/b.ts", bucket: "low-risk" },
    ];
    const blastRadius: BlastEntry[] = [
      {
        file: "src/a.ts",
        affected: [
          { path: "src/b.ts", depth: 1 }, // in diff — excluded
          { path: "src/external.ts", depth: 1 }, // not in diff — included
        ],
      },
    ];
    const result = computeCriticalDeps(files, blastRadius);
    const paths = result.map((d) => d.path);
    expect(paths).not.toContain("src/b.ts");
    expect(paths).toContain("src/external.ts");
  });

  it("returns empty array when all blast radius affected paths are in the diff", () => {
    const files: ImpactFile[] = [
      { path: "src/a.ts", bucket: "low-risk" },
      { path: "src/b.ts", bucket: "low-risk" },
    ];
    const blastRadius: BlastEntry[] = [
      {
        file: "src/a.ts",
        affected: [{ path: "src/b.ts", depth: 1 }], // in diff
      },
    ];
    expect(computeCriticalDeps(files, blastRadius)).toHaveLength(0);
  });

  it("returns empty array when blastRadius is empty", () => {
    const files: ImpactFile[] = [{ path: "src/a.ts", bucket: "low-risk" }];
    expect(computeCriticalDeps(files, [])).toHaveLength(0);
  });

  it("collects multiple changedFileDependents when a path appears in multiple blast entries", () => {
    const files: ImpactFile[] = [
      { path: "src/a.ts", bucket: "low-risk" },
      { path: "src/b.ts", bucket: "low-risk" },
    ];
    const blastRadius: BlastEntry[] = [
      { file: "src/a.ts", affected: [{ path: "src/external.ts", depth: 1 }] },
      { file: "src/b.ts", affected: [{ path: "src/external.ts", depth: 1 }] },
    ];
    const result = computeCriticalDeps(files, blastRadius);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/external.ts");
    expect(result[0].changedFileDependents).toHaveLength(2);
    expect(result[0].changedFileDependents).toContain("src/a.ts");
    expect(result[0].changedFileDependents).toContain("src/b.ts");
  });

  it("does not duplicate a changedFileDependent when it appears twice for the same affected path", () => {
    const files: ImpactFile[] = [{ path: "src/a.ts", bucket: "low-risk" }];
    const blastRadius: BlastEntry[] = [
      { file: "src/a.ts", affected: [{ path: "src/external.ts", depth: 1 }] },
      { file: "src/a.ts", affected: [{ path: "src/external.ts", depth: 1 }] }, // duplicate
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
      depRiskAnnotation({ path: "src/x.ts", changedFileDependents: ["src/a.ts"] }),
    ).toBeUndefined();
  });

  it("depRiskAnnotation returns 'affects 2 changed files' for 2 dependents", () => {
    expect(
      depRiskAnnotation({ path: "src/x.ts", changedFileDependents: ["src/a.ts", "src/b.ts"] }),
    ).toBe("affects 2 changed files");
  });

  it("depRiskAnnotation returns 'affects 3 changed files' for 3 dependents", () => {
    expect(
      depRiskAnnotation({
        path: "src/x.ts",
        changedFileDependents: ["src/a.ts", "src/b.ts", "src/c.ts"],
      }),
    ).toBe("affects 3 changed files");
  });

  it("depRelationship uses filename (not full path) for a single dependent", () => {
    expect(
      depRelationship({
        path: "src/x.ts",
        changedFileDependents: ["src/graph/kg-store.ts"],
      }),
    ).toBe("used by kg-store.ts");
  });

  it("depRelationship uses count summary for multiple dependents", () => {
    expect(
      depRelationship({
        path: "src/x.ts",
        changedFileDependents: ["src/a.ts", "src/b.ts"],
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
      { path: "src/a.ts", priority_score: 15, bucket: "needs-attention" },
    ];
    expect(computeHighImpact(files)).toHaveLength(1);
  });

  it("excludes files with priority_score of 14 (just below threshold)", () => {
    const files: ImpactFile[] = [
      { path: "src/a.ts", priority_score: 14, bucket: "needs-attention" },
    ];
    expect(computeHighImpact(files)).toHaveLength(0);
  });

  it("excludes files with undefined priority_score (treated as 0)", () => {
    const files: ImpactFile[] = [{ path: "src/a.ts", bucket: "low-risk" }];
    expect(computeHighImpact(files)).toHaveLength(0);
  });

  it("sorts results by priority_score descending", () => {
    const files: ImpactFile[] = [
      { path: "src/a.ts", priority_score: 15, bucket: "needs-attention" },
      { path: "src/b.ts", priority_score: 30, bucket: "needs-attention" },
      { path: "src/c.ts", priority_score: 22, bucket: "needs-attention" },
    ];
    const result = computeHighImpact(files);
    expect(result[0].priority_score).toBe(30);
    expect(result[1].priority_score).toBe(22);
    expect(result[2].priority_score).toBe(15);
  });

  it("maxScore derived value equals highest priority_score in high-impact set", () => {
    const files: ImpactFile[] = [
      { path: "src/a.ts", priority_score: 15, bucket: "needs-attention" },
      { path: "src/b.ts", priority_score: 30, bucket: "needs-attention" },
    ];
    const highImpact = computeHighImpact(files);
    const maxScore =
      highImpact.length > 0 ? Math.max(...highImpact.map((f) => f.priority_score ?? 0)) : 1;
    expect(maxScore).toBe(30);
  });

  it("highest score file gets 100% bar width via maxScore normalization", () => {
    const files: ImpactFile[] = [
      { path: "src/a.ts", priority_score: 15, bucket: "needs-attention" },
      { path: "src/b.ts", priority_score: 30, bucket: "needs-attention" },
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
    rule: 0,
    "strong-opinion": 1,
    convention: 2,
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
        review_id: "rev_cross_1",
        timestamp: "2026-03-25T10:00:00Z",
        files: ["src/a.ts"],
        violations: [
          { principle_id: "thin-handlers", severity: "strong-opinion", file_path: "src/a.ts" },
          { principle_id: "errors-are-values", severity: "rule", file_path: "src/b.ts" },
        ],
        honored: [],
        score: {
          rules: { passed: 0, total: 1 },
          opinions: { passed: 0, total: 1 },
          conventions: { passed: 0, total: 0 },
        },
        verdict: "BLOCKING",
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
        violation: v,
        inDegree: 0,
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
      (f.violations ?? []).map((v) => ({ filePath: f.path, violation: v, inDegree: 0 })),
    );

    expect(flatViolations).toHaveLength(0);
  });

  it("accumulated violations across multiple reviews appear in the flat list", () => {
    const reviews: ReviewEntry[] = [
      {
        review_id: "rev_a",
        timestamp: "2026-03-24T10:00:00Z",
        files: ["src/shared.ts"],
        violations: [{ principle_id: "p-rule", severity: "rule", file_path: "src/shared.ts" }],
        honored: [],
        score: {
          rules: { passed: 0, total: 1 },
          opinions: { passed: 0, total: 0 },
          conventions: { passed: 0, total: 0 },
        },
        verdict: "BLOCKING",
      },
      {
        review_id: "rev_b",
        timestamp: "2026-03-25T10:00:00Z",
        files: ["src/shared.ts"],
        violations: [
          { principle_id: "p-convention", severity: "convention", file_path: "src/shared.ts" },
        ],
        honored: [],
        score: {
          rules: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          conventions: { passed: 0, total: 1 },
        },
        verdict: "WARNING",
      },
    ];

    const violationMap = buildFileViolationMap(reviews);
    const sharedViolations = violationMap.get("src/shared.ts") ?? [];

    // Simulate ImpactTabs flattening for this one file
    const flatViolations = sharedViolations.map((v) => ({
      filePath: "src/shared.ts",
      violation: v,
      inDegree: 0,
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
      applyHostStyleVariables: vi.fn(),
      applyHostFonts: vi.fn(),
    }));

    // Import bridge AFTER vi.resetModules() but BEFORE calling init() — app stays null
    const { bridge: freshBridge } = await import("../stores/bridge.js");

    // sendMessage without init should throw the guard error
    await expect(freshBridge.sendMessage("hello")).rejects.toThrow("Bridge not initialized");

    vi.restoreAllMocks();
  });
});
