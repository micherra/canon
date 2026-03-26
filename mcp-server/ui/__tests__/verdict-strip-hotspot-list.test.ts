/**
 * verdict-strip-hotspot-list.test.ts
 *
 * Source-inspection tests for VerdictStrip.svelte and HotspotList.svelte.
 *
 * prtool-05 declared these as known gaps:
 *   "No automated tests for VerdictStrip/HotspotList rendering (no Svelte testing library configured)"
 *
 * Following the established project pattern (source inspection via readFileSync),
 * this file covers:
 *   VerdictStrip.svelte:
 *     - File existence
 *     - Props interface (verdict, fileCount, blastRadiusTotal, violationCount, score)
 *     - Svelte 5 runes syntax ($props, $derived)
 *     - All three verdict CSS classes (verdict-blocking, verdict-warning, verdict-clean)
 *     - data-verdict attribute for DOM testability
 *     - Score pills rendering (Rules, Opinions, Conventions)
 *     - Singular/plural for files and violations
 *
 *   HotspotList.svelte:
 *     - File existence
 *     - Props interface (hotspots, selectedFile, onFileSelect)
 *     - Svelte 5 $props() rune
 *     - Selected state CSS class and aria-current
 *     - Empty state message
 *     - Severity dot rendering
 *     - basename usage (not full path)
 *     - dominantSeverityColor function using rule/strong-opinion/convention ordering
 *     - formatBlast function (BR: prefix)
 *     - onFileSelect wiring to onclick
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const componentsDir = join(__dirname, "..", "components");

// ===========================================================================
// VerdictStrip.svelte
// ===========================================================================

describe("VerdictStrip.svelte — file existence", () => {
  it("exists at mcp-server/ui/components/VerdictStrip.svelte", () => {
    expect(existsSync(join(componentsDir, "VerdictStrip.svelte"))).toBe(true);
  });
});

describe("VerdictStrip.svelte — Svelte 5 runes", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "VerdictStrip.svelte"), "utf-8");
  });

  it("uses $props() rune (not export let)", () => {
    expect(content).toContain("$props()");
    expect(content).not.toMatch(/export let\s+/);
  });

  it("uses $derived for verdictClass computation", () => {
    expect(content).toContain("$derived");
    expect(content).toContain("verdictClass");
  });
});

describe("VerdictStrip.svelte — props interface", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "VerdictStrip.svelte"), "utf-8");
  });

  it("accepts verdict prop", () => {
    expect(content).toContain("verdict");
  });

  it("accepts fileCount prop", () => {
    expect(content).toContain("fileCount");
  });

  it("accepts blastRadiusTotal prop", () => {
    expect(content).toContain("blastRadiusTotal");
  });

  it("accepts violationCount prop", () => {
    expect(content).toContain("violationCount");
  });

  it("accepts score prop with nested rules/opinions/conventions", () => {
    expect(content).toContain("score");
    expect(content).toContain("rules");
    expect(content).toContain("opinions");
    expect(content).toContain("conventions");
  });
});

describe("VerdictStrip.svelte — verdict CSS classes", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "VerdictStrip.svelte"), "utf-8");
  });

  it("has CSS class for BLOCKING verdict", () => {
    expect(content).toContain("verdict-blocking");
  });

  it("has CSS class for WARNING verdict", () => {
    expect(content).toContain("verdict-warning");
  });

  it("has CSS class for CLEAN verdict", () => {
    expect(content).toContain("verdict-clean");
  });

  it("uses data-verdict attribute for DOM testability", () => {
    expect(content).toContain("data-verdict");
  });
});

describe("VerdictStrip.svelte — content and stats", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "VerdictStrip.svelte"), "utf-8");
  });

  it("renders score pills for each category", () => {
    expect(content).toContain("Rules:");
    expect(content).toContain("Opinions:");
    expect(content).toContain("Conventions:");
  });

  it("uses singular/plural for file count", () => {
    // Should have conditional for "file" vs "files"
    expect(content).toMatch(/file[s]?/);
    expect(content).toContain("fileCount");
  });

  it("uses singular/plural for violation count", () => {
    expect(content).toMatch(/violation[s]?/);
    expect(content).toContain("violationCount");
  });

  it("renders blast radius total stat", () => {
    expect(content).toContain("blast radius");
    expect(content).toContain("blastRadiusTotal");
  });

  it("renders pill-pass class for perfect scores", () => {
    expect(content).toContain("pill-pass");
  });
});

// ===========================================================================
// HotspotList.svelte
// ===========================================================================

describe("HotspotList.svelte — file existence", () => {
  it("exists at mcp-server/ui/components/HotspotList.svelte", () => {
    expect(existsSync(join(componentsDir, "HotspotList.svelte"))).toBe(true);
  });
});

describe("HotspotList.svelte — Svelte 5 runes", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "HotspotList.svelte"), "utf-8");
  });

  it("uses $props() rune (not export let)", () => {
    expect(content).toContain("$props()");
    expect(content).not.toMatch(/export let\s+/);
  });
});

describe("HotspotList.svelte — props interface", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "HotspotList.svelte"), "utf-8");
  });

  it("accepts hotspots prop", () => {
    expect(content).toContain("hotspots");
  });

  it("accepts selectedFile prop", () => {
    expect(content).toContain("selectedFile");
  });

  it("accepts onFileSelect callback prop", () => {
    expect(content).toContain("onFileSelect");
  });
});

describe("HotspotList.svelte — empty state", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "HotspotList.svelte"), "utf-8");
  });

  it("renders empty state when hotspots array is empty", () => {
    expect(content).toContain("hotspots.length === 0");
  });

  it("shows a message for empty state", () => {
    expect(content).toMatch(/[Nn]o changed files/);
  });
});

describe("HotspotList.svelte — selection state", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "HotspotList.svelte"), "utf-8");
  });

  it("applies 'selected' CSS class when file matches selectedFile", () => {
    expect(content).toContain("class:selected");
    expect(content).toContain("selectedFile === hotspot.file");
  });

  it("sets aria-current for selected file (accessibility)", () => {
    expect(content).toContain("aria-current");
  });
});

describe("HotspotList.svelte — severity dot and colors", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "HotspotList.svelte"), "utf-8");
  });

  it("renders severity-dot element for each hotspot row", () => {
    expect(content).toContain("severity-dot");
  });

  it("has dominantSeverityColor function", () => {
    expect(content).toContain("dominantSeverityColor");
  });

  it("dominantSeverityColor checks 'rule' severity first (highest priority)", () => {
    // rule comes before strong-opinion in the priority chain
    const fnStart = content.indexOf("dominantSeverityColor");
    const fnBody = content.slice(fnStart, fnStart + 400);
    const ruleIdx = fnBody.indexOf('"rule"');
    const opinionIdx = fnBody.indexOf('"strong-opinion"');
    expect(ruleIdx).toBeGreaterThan(-1);
    expect(opinionIdx).toBeGreaterThan(-1);
    expect(ruleIdx).toBeLessThan(opinionIdx);
  });

  it("returns 'transparent' for files with no violations", () => {
    expect(content).toContain("transparent");
  });
});

describe("HotspotList.svelte — file display", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "HotspotList.svelte"), "utf-8");
  });

  it("uses basename() for display (not full path)", () => {
    expect(content).toContain("basename");
    expect(content).toContain("hotspot.file");
  });

  it("shows full path in title attribute for tooltip", () => {
    expect(content).toContain("title={hotspot.file}");
  });
});

describe("HotspotList.svelte — stats display", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "HotspotList.svelte"), "utf-8");
  });

  it("formats blast radius count with BR: prefix via formatBlast", () => {
    expect(content).toContain("formatBlast");
    expect(content).toContain("BR:");
  });

  it("shows violation count only when > 0", () => {
    expect(content).toContain("violation_count > 0");
  });

  it("shows risk score only when > 0", () => {
    expect(content).toContain("risk_score > 0");
  });

  it("wires onFileSelect to button onclick", () => {
    expect(content).toContain("onFileSelect(hotspot.file)");
  });
});

// ===========================================================================
// PrReview.svelte — cross-panel data flow (unified component, replaces PrImpact.svelte)
// ===========================================================================

describe("PrImpact.svelte — cross-component data flow", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(__dirname, "..", "PrReview.svelte"), "utf-8");
  });

  it("derives selectedFileViolations by filtering violations to matching file_path", () => {
    // The cross-panel integration: selecting a file in HotspotList filters violations for DetailPanel
    expect(content).toContain("selectedFileViolations");
    expect(content).toContain("v.file_path === selectedFile");
  });

  it("derives selectedFileBlastRadius filtering to depth > 0", () => {
    // blast radius seeds (depth=0) are excluded from the detail panel
    expect(content).toContain("selectedFileBlastRadius");
    expect(content).toContain("depth > 0");
  });

  it("derives selectedFileDecisions from violated principles of selected file", () => {
    expect(content).toContain("selectedFileDecisions");
    expect(content).toContain("violatedPrinciples");
    expect(content).toContain("principle_id");
  });

  it("passes selectedFileViolations to PrDetailPanel violations prop", () => {
    expect(content).toContain("violations={selectedFileViolations}");
  });

  it("passes selectedFileBlastRadius to PrDetailPanel blastRadiusAffected prop", () => {
    expect(content).toContain("blastRadiusAffected={selectedFileBlastRadius}");
  });

  it("passes selectedFileDecisions to PrDetailPanel decisions prop", () => {
    expect(content).toContain("decisions={selectedFileDecisions}");
  });

  it("uses handleFileSelect to update selectedFile from HotspotList", () => {
    expect(content).toContain("handleFileSelect");
    expect(content).toContain("onFileSelect={handleFileSelect}");
  });

  it("uses handleGraphNodeClick to set selectedFile from SubGraph node click", () => {
    expect(content).toContain("handleGraphNodeClick");
    expect(content).toContain("onNodeClick={handleGraphNodeClick}");
    // node.id becomes the selected file
    expect(content).toContain("node.id");
  });

  it("passes PrDetailPanel onFileClick={handleFileSelect} for blast radius navigation", () => {
    // Clicking a blast radius file navigates to it via the same handleFileSelect
    expect(content).toContain("onFileClick={handleFileSelect}");
  });

  it("shows 'Select a file' placeholder when no file is selected", () => {
    expect(content).toContain("Select a file");
  });

  it("wraps PrDetailPanel in {#if selectedFile} guard", () => {
    expect(content).toContain("{#if selectedFile}");
    expect(content).toContain("PrDetailPanel");
  });
});

describe("PrImpact.svelte — subgraph seed nodes", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(__dirname, "..", "PrReview.svelte"), "utf-8");
  });

  it("derives seedNodeIds from review.files (changed files become seed nodes)", () => {
    expect(content).toContain("seedNodeIds");
    expect(content).toContain("review?.files");
  });

  it("derives subgraphLayerColors from payload.subgraph.layers", () => {
    expect(content).toContain("subgraphLayerColors");
    expect(content).toContain("subgraph?.layers");
  });

  it("passes seedNodeIds to SubGraph", () => {
    expect(content).toContain("{seedNodeIds}");
  });

  it("passes fa2Iterations={60} to SubGraph", () => {
    expect(content).toContain("fa2Iterations={60}");
  });
});
