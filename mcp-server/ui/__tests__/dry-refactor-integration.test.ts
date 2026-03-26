/**
 * dry-refactor-integration.test.ts
 *
 * Integration and coverage-gap tests for the DRY refactor across Waves 1-5.
 *
 * Covers:
 *   1. Cross-wave: getSeverityColor (Wave 1 utils) consumed correctly by ViolationCard (Wave 3)
 *   2. Cross-wave: FilePath.svelte (Wave 2 component) imported by all three Wave 3 leaf components
 *   3. Cross-wave: btn-reset global class applied in all Wave 3 refactored leaf components
 *   4. Cross-wave: useDataLoader (Wave 2 composable) imported by all Wave 5 views
 *   5. Cross-wave: EmptyState (Wave 2 component) imported by all Wave 5 views
 *   6. Wave 4 known gap: ImpactTabs.svelte structural tests (no test file existed)
 *   7. Wave 5 known gap: DriftReport.svelte structural tests (no test file existed)
 *   8. Wave 5 known gap: Compliance.svelte structural tests (no test file existed)
 *   9. Wave 5 known gap: GraphQuery.svelte structural tests (no test file existed)
 *  10. getSeverityColor fallback aligns with SEVERITY_COLORS constant (no regression)
 *  11. FileContext.svelte uses getSeverityColor and pluralize from lib/utils (Wave 5)
 *  12. useDataLoader exports LoaderStatus type and DataLoaderState interface
 *  13. EmptyState.svelte and Badge.svelte structural contracts (Wave 2)
 *  14. FilePath.svelte structural contract (Wave 2)
 *
 * All tests use source-inspection (readFileSync) — the established pattern for
 * Svelte components in this codebase where the Svelte compiler is not available
 * in the vitest/Node environment.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { getSeverityColor } from "../lib/utils.ts";
import { SEVERITY_COLORS } from "../lib/constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "..");
const componentsDir = join(uiDir, "components");
const libDir = join(uiDir, "lib");

// =============================================================================
// 1. Cross-wave: getSeverityColor (Wave 1) → ViolationCard (Wave 3)
//    Verify the refactored import path and that color values are preserved.
// =============================================================================

describe("Cross-wave: getSeverityColor utility → ViolationCard integration", () => {
  it("ViolationCard.svelte imports getSeverityColor from lib/utils (not SEVERITY_COLORS from constants)", () => {
    const content = readFileSync(join(componentsDir, "ViolationCard.svelte"), "utf-8");
    expect(content).toContain("getSeverityColor");
    expect(content).toContain("../lib/utils");
    // Must NOT import SEVERITY_COLORS directly (the import statement, not the comment)
    expect(content).not.toMatch(/^import.*SEVERITY_COLORS/m);
    expect(content).not.toMatch(/^import.*from.*lib\/constants/m);
  });

  it("getSeverityColor returns same value as SEVERITY_COLORS[severity] for all three valid severities", () => {
    // This is the behavioral contract: refactor must not change color values
    expect(getSeverityColor("rule")).toBe(SEVERITY_COLORS["rule"]);
    expect(getSeverityColor("strong-opinion")).toBe(SEVERITY_COLORS["strong-opinion"]);
    expect(getSeverityColor("convention")).toBe(SEVERITY_COLORS["convention"]);
  });

  it("getSeverityColor fallback (#636a80) differs from old inline fallback (#888888) but is intentional", () => {
    // The refactor changed the unknown fallback from #888888 to #636a80.
    // Severity is a typed union so unknown values cannot reach this in practice.
    // This test documents the intentional change.
    const fallback = getSeverityColor("unknown-type");
    expect(fallback).toBe("#636a80");
    expect(fallback).not.toBe("#888888");
  });

  it("ViolationCard.svelte uses $derived(getSeverityColor(severity)) for the severity color", () => {
    const content = readFileSync(join(componentsDir, "ViolationCard.svelte"), "utf-8");
    expect(content).toContain("getSeverityColor(severity)");
    expect(content).toContain("$derived");
  });
});

// =============================================================================
// 2. Cross-wave: FilePath.svelte (Wave 2) imported by all Wave 3 leaf components
//    Each component must delegate path splitting to FilePath, not inline it.
// =============================================================================

describe("Cross-wave: FilePath.svelte (Wave 2) consumed by Wave 3 leaf components", () => {
  const leafComponents = [
    { name: "ImpactRow.svelte", path: join(componentsDir, "ImpactRow.svelte") },
    { name: "ViolationCard.svelte", path: join(componentsDir, "ViolationCard.svelte") },
    { name: "DepRow.svelte", path: join(componentsDir, "DepRow.svelte") },
  ];

  for (const { name, path } of leafComponents) {
    it(`${name} imports FilePath from ./FilePath.svelte`, () => {
      const content = readFileSync(path, "utf-8");
      expect(content).toContain('import FilePath from "./FilePath.svelte"');
    });

    it(`${name} uses <FilePath path={...} /> component (no inline span.file-path split logic)`, () => {
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("<FilePath");
      // Must not contain the old inline dir-splitting derived variables
      expect(content).not.toMatch(/\$derived\s*\(\s*filePath\.slice/);
      expect(content).not.toMatch(/lastIndexOf\s*\(/);
    });
  }

  it("FilePath.svelte itself delegates to splitFilePath from lib/utils (single source of truth)", () => {
    const content = readFileSync(join(componentsDir, "FilePath.svelte"), "utf-8");
    expect(content).toContain("splitFilePath");
    expect(content).toContain("../lib/utils");
  });

  it("FilePath.svelte uses {#if parts.dir} guard so bare filenames omit the dir-part span", () => {
    const content = readFileSync(join(componentsDir, "FilePath.svelte"), "utf-8");
    expect(content).toContain("{#if parts.dir}");
  });
});

// =============================================================================
// 3. Cross-wave: btn-reset global class applied in all Wave 3 refactored buttons
//    Buttons must no longer duplicate border/cursor/background reset CSS inline.
// =============================================================================

describe("Cross-wave: btn-reset global class in Wave 3 refactored leaf components", () => {
  it("ImpactRow.svelte button has class btn-reset", () => {
    const content = readFileSync(join(componentsDir, "ImpactRow.svelte"), "utf-8");
    expect(content).toContain("btn-reset");
    // Should appear on the button element
    expect(content).toMatch(/class="impact-row btn-reset"/);
  });

  it("ViolationCard.svelte button has class btn-reset", () => {
    const content = readFileSync(join(componentsDir, "ViolationCard.svelte"), "utf-8");
    expect(content).toContain("btn-reset");
    expect(content).toMatch(/class="violation-card btn-reset"/);
  });

  it("DepRow.svelte button has class btn-reset", () => {
    const content = readFileSync(join(componentsDir, "DepRow.svelte"), "utf-8");
    expect(content).toContain("btn-reset");
    expect(content).toMatch(/class="dep-row btn-reset"/);
  });

  it("HotspotList.svelte button has class btn-reset (Wave 4 refactor)", () => {
    const content = readFileSync(join(componentsDir, "HotspotList.svelte"), "utf-8");
    expect(content).toContain("btn-reset");
    expect(content).toMatch(/class="btn-reset hotspot-row"/);
  });

  it("ImpactRow.svelte does not duplicate cursor:pointer in .impact-row CSS (handled by btn-reset)", () => {
    const content = readFileSync(join(componentsDir, "ImpactRow.svelte"), "utf-8");
    // cursor: pointer should be removed from the scoped component CSS
    // (it's provided by global .btn-reset)
    const styleBlock = content.slice(content.indexOf("<style>"));
    expect(styleBlock).not.toContain("cursor: pointer");
  });

  it("ViolationCard.svelte does not duplicate border: none in .violation-card CSS (handled by btn-reset)", () => {
    const content = readFileSync(join(componentsDir, "ViolationCard.svelte"), "utf-8");
    const styleBlock = content.slice(content.indexOf("<style>"));
    expect(styleBlock).not.toContain("border: none");
  });
});

// =============================================================================
// 4. Cross-wave: useDataLoader (Wave 2) imported by all Wave 5 views
// =============================================================================

describe("Cross-wave: useDataLoader composable (Wave 2) consumed by Wave 5 views", () => {
  const views = [
    { name: "DriftReport.svelte", path: join(uiDir, "DriftReport.svelte") },
    { name: "Compliance.svelte", path: join(uiDir, "Compliance.svelte") },
    { name: "GraphQuery.svelte", path: join(uiDir, "GraphQuery.svelte") },
    { name: "CodebaseGraph.svelte", path: join(uiDir, "CodebaseGraph.svelte") },
    { name: "PrReview.svelte", path: join(uiDir, "PrReview.svelte") },
    { name: "FileContext.svelte", path: join(uiDir, "FileContext.svelte") },
  ];

  for (const { name, path } of views) {
    it(`${name} imports useDataLoader from ./lib/useDataLoader.svelte`, () => {
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("useDataLoader");
      expect(content).toContain("useDataLoader.svelte");
    });
  }

  it("useDataLoader.svelte.ts exports the DataLoaderState interface", () => {
    const content = readFileSync(join(libDir, "useDataLoader.svelte.ts"), "utf-8");
    expect(content).toContain("DataLoaderState");
    expect(content).toContain("export interface DataLoaderState");
  });

  it("useDataLoader.svelte.ts exports LoaderStatus type", () => {
    const content = readFileSync(join(libDir, "useDataLoader.svelte.ts"), "utf-8");
    expect(content).toContain("LoaderStatus");
    expect(content).toContain('export type LoaderStatus = "loading" | "done" | "error"');
  });

  it("useDataLoader.svelte.ts transitions status from loading to done on success", () => {
    const content = readFileSync(join(libDir, "useDataLoader.svelte.ts"), "utf-8");
    expect(content).toContain('status = "done"');
    expect(content).toContain('status = "error"');
    // Initial state must be "loading"
    expect(content).toContain('"loading"');
  });

  it("useDataLoader.svelte.ts extracts .message from Error instances (error handling contract)", () => {
    const content = readFileSync(join(libDir, "useDataLoader.svelte.ts"), "utf-8");
    expect(content).toContain("err instanceof Error");
    expect(content).toContain("err.message");
    expect(content).toContain("String(err)");
  });
});

// =============================================================================
// 5. Cross-wave: EmptyState (Wave 2) imported by all Wave 5 views
// =============================================================================

describe("Cross-wave: EmptyState component (Wave 2) consumed by Wave 5 views", () => {
  const views = [
    { name: "DriftReport.svelte", path: join(uiDir, "DriftReport.svelte") },
    { name: "Compliance.svelte", path: join(uiDir, "Compliance.svelte") },
    { name: "GraphQuery.svelte", path: join(uiDir, "GraphQuery.svelte") },
    { name: "CodebaseGraph.svelte", path: join(uiDir, "CodebaseGraph.svelte") },
    { name: "PrReview.svelte", path: join(uiDir, "PrReview.svelte") },
    { name: "FileContext.svelte", path: join(uiDir, "FileContext.svelte") },
  ];

  for (const { name, path } of views) {
    it(`${name} imports EmptyState from ./components/EmptyState.svelte`, () => {
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("EmptyState");
      expect(content).toContain("EmptyState.svelte");
    });

    it(`${name} uses <EmptyState message=... /> for loading state`, () => {
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("<EmptyState");
      // All views should use EmptyState for at least the loading state
      expect(content).toContain('status === "loading"');
    });

    it(`${name} uses EmptyState with isError prop for error state`, () => {
      const content = readFileSync(path, "utf-8");
      // Error path must use isError on EmptyState
      expect(content).toMatch(/EmptyState[^>]*isError/);
    });

    it(`${name} does not contain inline .empty-state CSS class definition (removed, uses global)`, () => {
      const content = readFileSync(path, "utf-8");
      // The local .empty-state CSS block should be gone; the class is now in base.css
      const styleBlock = content.includes("<style>")
        ? content.slice(content.indexOf("<style>"))
        : "";
      expect(styleBlock).not.toMatch(/\.empty-state\s*\{/);
    });
  }
});

// =============================================================================
// 6. Wave 4 known gap: ImpactTabs.svelte structural tests
//    No test file existed for ImpactTabs prior to this refactor.
// =============================================================================

describe("ImpactTabs.svelte — structure (Wave 4 known gap)", () => {
  const path = join(componentsDir, "ImpactTabs.svelte");

  it("exists at mcp-server/ui/components/ImpactTabs.svelte", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("uses Svelte 5 $props() rune", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("$props()");
  });

  it("accepts files, blastRadius, and onPrompt props", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("files");
    expect(content).toContain("blastRadius");
    expect(content).toContain("onPrompt");
  });

  it("imports ImpactRow, ViolationCard, and DepRow child components", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("ImpactRow");
    expect(content).toContain("ViolationCard");
    expect(content).toContain("DepRow");
  });

  it("has three tabs: high-impact, violations, critical-deps", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("high-impact");
    expect(content).toContain("violations");
    expect(content).toContain("critical-deps");
  });

  it("uses $state for activeTab", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("$state");
    expect(content).toContain("activeTab");
  });

  it("uses $derived for highImpactFiles filtered list", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("$derived");
    expect(content).toContain("highImpactFiles");
  });

  it("local .empty-state CSS block (if present) does not re-declare the flex centering properties handled by base.css", () => {
    const content = readFileSync(path, "utf-8");
    // Extract just the .empty-state { ... } block from the style section
    const emptyStateMatch = content.match(/\.empty-state\s*\{([^}]*)\}/);
    if (emptyStateMatch) {
      const emptyStateBlock = emptyStateMatch[1];
      // Wave 4 reduced this to padding + text-align only.
      // The global base.css provides display:flex, align-items, justify-content, color, font-size.
      expect(emptyStateBlock).not.toMatch(/display\s*:/);
      expect(emptyStateBlock).not.toMatch(/align-items\s*:/);
      expect(emptyStateBlock).not.toMatch(/justify-content\s*:/);
    }
    // If no .empty-state block, that's also fine
  });
});

// =============================================================================
// 7-9. Wave 5 known gaps: DriftReport, Compliance, GraphQuery structural tests
// =============================================================================

describe("DriftReport.svelte — structure (Wave 5 known gap)", () => {
  const path = join(uiDir, "DriftReport.svelte");

  it("exists at mcp-server/ui/DriftReport.svelte", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("calls bridge.callTool('get_drift_report')", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("get_drift_report");
  });

  it("uses useDataLoader (not onMount + manual state)", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("useDataLoader");
    expect(content).not.toContain("onMount");
  });

  it("handles all three loader states: loading, error, done", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('"loading"');
    expect(content).toContain('"error"');
    // Done is handled by the {:else if data} branch
    expect(content).toContain("data");
  });
});

describe("Compliance.svelte — structure (Wave 5 known gap)", () => {
  const path = join(uiDir, "Compliance.svelte");

  it("exists at mcp-server/ui/Compliance.svelte", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("uses useDataLoader (not onMount + manual state)", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("useDataLoader");
    expect(content).not.toContain("onMount");
  });

  it("handles all three loader states: loading, error, done", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('"loading"');
    expect(content).toContain('"error"');
    expect(content).toContain("data");
  });
});

describe("GraphQuery.svelte — structure (Wave 5 known gap)", () => {
  const path = join(uiDir, "GraphQuery.svelte");

  it("exists at mcp-server/ui/GraphQuery.svelte", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("uses useDataLoader (not onMount + manual state)", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("useDataLoader");
    expect(content).not.toContain("onMount");
  });

  it("handles all three loader states: loading, error, done", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('"loading"');
    expect(content).toContain('"error"');
    expect(content).toContain("data");
  });
});

// =============================================================================
// 10. Wave 5: FileContext.svelte uses getSeverityColor and pluralize from lib/utils
// =============================================================================

describe("FileContext.svelte — Wave 5 utils consumption", () => {
  const path = join(uiDir, "FileContext.svelte");

  it("imports getSeverityColor from lib/utils (not inline or from constants)", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("getSeverityColor");
    expect(content).toContain("lib/utils");
  });

  it("imports pluralize from lib/utils (replaces manual ternaries)", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("pluralize");
    expect(content).toContain("lib/utils");
  });

  it("uses useDataLoader for push-mode bridge.waitForToolResult", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("useDataLoader");
    expect(content).not.toContain("onMount");
  });

  it("canvas $effect checks status === 'done' after useDataLoader migration", () => {
    const content = readFileSync(path, "utf-8");
    // The canvas rendering effect must gate on done status
    expect(content).toContain('"done"');
    expect(content).toContain("$effect");
  });
});

// =============================================================================
// 11. Wave 5: PrReview.svelte useDataLoader wiring
// =============================================================================

describe("PrReview.svelte — Wave 5 useDataLoader wiring", () => {
  const path = join(uiDir, "PrReview.svelte");

  it("exposes loader.status, loader.data, loader.errorMsg via $derived", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("loader.status");
    expect(content).toContain("loader.data");
    expect(content).toContain("loader.errorMsg");
    expect(content).toContain("$derived");
  });

  it("uses status === 'loading' guard for loading state (not isLoading boolean)", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('status === "loading"');
    expect(content).not.toMatch(/let isLoading\s*=/);
  });

  it("uses status === 'error' guard for error state", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('status === "error"');
  });
});

// =============================================================================
// 12. Wave 2: EmptyState.svelte and Badge.svelte structural contracts
// =============================================================================

describe("EmptyState.svelte — structural contract (Wave 2)", () => {
  const path = join(componentsDir, "EmptyState.svelte");

  it("exists at mcp-server/ui/components/EmptyState.svelte", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("uses $props() for Svelte 5 runes syntax", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("$props()");
  });

  it("accepts message and optional isError props", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("message");
    expect(content).toContain("isError");
  });

  it("renders div with class empty-state (relying on global base.css)", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('class="empty-state"');
  });

  it("applies error modifier via class:error={isError}", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("class:error={isError}");
  });

  it("has no local <style> block (all styles from base.css)", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).not.toContain("<style>");
  });
});

describe("Badge.svelte — structural contract (Wave 2)", () => {
  const path = join(componentsDir, "Badge.svelte");

  it("exists at mcp-server/ui/components/Badge.svelte", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("uses $props() for Svelte 5 runes syntax", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("$props()");
  });

  it("accepts text, color, bg, and rounded props", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("text");
    expect(content).toContain("color");
    expect(content).toContain("bg");
    expect(content).toContain("rounded");
  });

  it("uses CSS custom property --badge-color for text color", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("--badge-color");
  });

  it("uses CSS custom property --badge-bg for background color", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("--badge-bg");
  });

  it("rounded prop switches to pill shape via class:rounded", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("class:rounded");
  });
});

// =============================================================================
// 13. Wave 2: FilePath.svelte structural contract
// =============================================================================

describe("FilePath.svelte — structural contract (Wave 2)", () => {
  const path = join(componentsDir, "FilePath.svelte");

  it("exists at mcp-server/ui/components/FilePath.svelte", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("uses $props() for Svelte 5 runes syntax", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("$props()");
  });

  it("accepts a single path prop (string)", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("path: string");
  });

  it("derives parts using $derived(splitFilePath(path))", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("$derived(splitFilePath(path))");
  });

  it("renders .dir-part span for muted directory prefix", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('class="dir-part"');
  });

  it("renders .file-name span for bold filename", () => {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('class="file-name"');
  });
});
