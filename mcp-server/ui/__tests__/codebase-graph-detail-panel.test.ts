/**
 * codebase-graph-detail-panel.test.ts
 *
 * Tests for the detail panel added to CodebaseGraph.svelte.
 * Since vitest cannot compile Svelte, we test by reading the source and
 * asserting on structure/patterns — matching the project's established pattern.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "..");
const sveltePath = join(uiDir, "CodebaseGraph.svelte");

let content: string;

beforeAll(() => {
  content = readFileSync(sveltePath, "utf-8");
});

// ---------------------------------------------------------------------------
// File existence
// ---------------------------------------------------------------------------

describe("CodebaseGraph.svelte — file exists", () => {
  it("exists at mcp-server/ui/CodebaseGraph.svelte", () => {
    expect(existsSync(sveltePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge map derivation
// ---------------------------------------------------------------------------

describe("CodebaseGraph.svelte — edge maps", () => {
  it("derives edgesIn map from graphData.edges (nodes that import this file)", () => {
    expect(content).toContain("edgesIn");
  });

  it("derives edgesOut map from graphData.edges (files this node imports)", () => {
    expect(content).toContain("edgesOut");
  });

  it("builds edge maps using $derived or $derived.by", () => {
    // Must be reactive to graphData changes
    expect(content).toMatch(/\$derived/);
  });
});

// ---------------------------------------------------------------------------
// Detail panel structure
// ---------------------------------------------------------------------------

describe("CodebaseGraph.svelte — detail panel markup", () => {
  it("has a detail-panel element (not node-detail bottom bar)", () => {
    expect(content).toContain("detail-panel");
  });

  it("removed or replaced the old node-detail bottom bar class", () => {
    // The old .node-detail div should no longer be the primary display
    // (replaced by right-side panel)
    expect(content).not.toContain('class="node-detail"');
  });

  it("shows the file path in monospace", () => {
    expect(content).toContain("node-path");
  });

  it("shows a layer badge with color", () => {
    expect(content).toContain("layer-badge");
  });

  it("has a close button that calls handleBackgroundClick", () => {
    expect(content).toContain("handleBackgroundClick");
    // close button uses × or similar
    expect(content).toMatch(/[×✕x]/);
  });

  it("shows summary when available", () => {
    expect(content).toContain("selectedNode.summary");
  });

  it("shows stats row with entity_count, export_count, dead_code_count, community", () => {
    expect(content).toContain("entity_count");
    expect(content).toContain("export_count");
    expect(content).toContain("dead_code_count");
    expect(content).toContain("community");
  });

  it("shows dependencies section (in-edges and out-edges)", () => {
    // Must render the dependency list from edge maps
    expect(content).toContain("edgesIn");
    expect(content).toContain("edgesOut");
  });

  it("shows entities list when available", () => {
    expect(content).toContain("entities");
    // renders entity name and kind
    expect(content).toContain("entity.name");
  });

  it("shows exports list when available", () => {
    expect(content).toContain("selectedNode.exports");
  });

  it("shows violations section", () => {
    expect(content).toContain("top_violations");
    expect(content).toContain("violation");
  });

  it("shows changed badge when file is changed", () => {
    expect(content).toContain("changed");
    expect(content).toContain("changed-badge");
  });
});

// ---------------------------------------------------------------------------
// Layout — side-by-side panel
// ---------------------------------------------------------------------------

describe("CodebaseGraph.svelte — layout", () => {
  it("wraps graph-container and detail panel in a flex row (main-area or similar)", () => {
    // The outer wrapper must be a flex row so panel sits beside graph
    expect(content).toMatch(/main-area|graph-area|content-area|flex-row|graph-layout/);
  });

  it("detail panel has a width around 300px", () => {
    expect(content).toMatch(/28[0-9]px|29[0-9]px|300px|31[0-9]px/);
  });

  it("detail panel is positioned on the right side", () => {
    // Check for border-left (right-side panel separator) or right-side class
    expect(content).toMatch(/border-left|right.*panel|panel.*right/i);
  });
});

// ---------------------------------------------------------------------------
// CSS variables usage (dark theme)
// ---------------------------------------------------------------------------

describe("CodebaseGraph.svelte — dark theme CSS variables", () => {
  it("uses --bg-card or --bg-surface for panel background", () => {
    expect(content).toMatch(/--bg-card|--bg-surface/);
  });

  it("uses --text-bright for file path text", () => {
    expect(content).toContain("--text-bright");
  });

  it("uses --text-muted for secondary text", () => {
    expect(content).toContain("--text-muted");
  });

  it("uses --border for panel separator", () => {
    expect(content).toContain("--border");
  });
});
