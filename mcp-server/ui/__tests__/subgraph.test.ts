/**
 * subgraph.test.ts
 *
 * Tests for SubGraph.svelte (content/structure) and the fa2Iterations addition to sigmaGraph.ts.
 *
 * Since vitest cannot compile Svelte components directly (no Svelte plugin in vitest.config.ts),
 * SubGraph.svelte is tested by reading its source and asserting on structure and patterns.
 * This matches the project's established pattern (see pr-impact-entry.test.ts).
 *
 * The sigmaGraph.ts change (fa2Iterations in opts) IS testable via function signature inspection.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "..");
const componentsDir = join(uiDir, "components");
const libDir = join(uiDir, "lib");

// ---------------------------------------------------------------------------
// SubGraph.svelte — file existence and structure
// ---------------------------------------------------------------------------

describe("SubGraph.svelte — file existence", () => {
  const sveltePath = join(componentsDir, "SubGraph.svelte");

  it("exists at mcp-server/ui/components/SubGraph.svelte", () => {
    expect(existsSync(sveltePath)).toBe(true);
  });
});

describe("SubGraph.svelte — props interface", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "SubGraph.svelte"), "utf-8");
  });

  it("uses Svelte 5 $props() rune (not export let)", () => {
    expect(content).toContain("$props()");
    expect(content).not.toContain("export let nodes");
    expect(content).not.toContain("export let edges");
  });

  it("accepts nodes prop", () => {
    expect(content).toContain("nodes");
  });

  it("accepts edges prop", () => {
    expect(content).toContain("edges");
  });

  it("accepts seedNodeIds prop", () => {
    expect(content).toContain("seedNodeIds");
  });

  it("accepts layerColors prop", () => {
    expect(content).toContain("layerColors");
  });

  it("accepts onNodeClick prop", () => {
    expect(content).toContain("onNodeClick");
  });

  it("accepts onBackgroundClick prop", () => {
    expect(content).toContain("onBackgroundClick");
  });

  it("accepts optional fa2Iterations prop with default of 60", () => {
    expect(content).toContain("fa2Iterations");
    expect(content).toContain("60");
  });
});

describe("SubGraph.svelte — implementation: no store coupling", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "SubGraph.svelte"), "utf-8");
  });

  it("does NOT use graphData store value (may import types only)", () => {
    // Type-only imports from graphData are acceptable — we check that no store
    // *values* (reactive store subscriptions) are used, not import paths.
    // graphData, edgeIn, edgeOut, layerColors are store values — must not appear as subscriptions.
    expect(content).not.toContain("$graphData");
    expect(content).not.toContain("$edgeIn");
    expect(content).not.toContain("$edgeOut");
    expect(content).not.toContain("$layerColors");
  });

  it("does NOT import filters store", () => {
    expect(content).not.toContain("stores/filters");
    expect(content).not.toContain("from '../stores/filters'");
    expect(content).not.toContain('from "../stores/filters"');
  });

  it("does NOT import selection store", () => {
    expect(content).not.toContain("stores/selection");
  });

  it("does NOT import bridge store (SubGraph is pure UI — no tool calls)", () => {
    expect(content).not.toContain("stores/bridge");
  });

  it("does NOT export getApi() (parent controls only through props)", () => {
    expect(content).not.toContain("export function getApi");
  });
});

describe("SubGraph.svelte — implementation: sigmaGraph usage", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "SubGraph.svelte"), "utf-8");
  });

  it("imports buildSigmaGraph from ../lib/sigmaGraph", () => {
    expect(content).toContain("buildSigmaGraph");
    expect(content).toContain("sigmaGraph");
  });

  it("uses $effect to rebuild graph when data changes", () => {
    expect(content).toContain("$effect");
  });

  it("builds edgeIn map from edges prop", () => {
    expect(content).toContain("edgeIn");
  });

  it("builds edgeOut map from edges prop", () => {
    expect(content).toContain("edgeOut");
  });

  it("calls highlightCascade with seedNodeIds after graph construction", () => {
    expect(content).toContain("highlightCascade");
    expect(content).toContain("seedNodeIds");
  });

  it("binds a div to container for Sigma mount point", () => {
    expect(content).toContain("bind:this");
    expect(content).toContain("container");
  });
});

describe("SubGraph.svelte — lifecycle: WebGL context cleanup", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(componentsDir, "SubGraph.svelte"), "utf-8");
  });

  it("imports onDestroy from svelte", () => {
    expect(content).toContain("onDestroy");
    expect(content).toContain('from "svelte"');
  });

  it("calls graphApi.destroy() in onDestroy to prevent WebGL context leak", () => {
    expect(content).toContain("destroy");
    expect(content).toContain("onDestroy");
  });
});

// ---------------------------------------------------------------------------
// sigmaGraph.ts — fa2Iterations parameter
// ---------------------------------------------------------------------------

describe("sigmaGraph.ts — fa2Iterations opts parameter", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(join(libDir, "sigmaGraph.ts"), "utf-8");
  });

  it("accepts fa2Iterations as an optional field in opts", () => {
    expect(content).toContain("fa2Iterations");
  });

  it("uses opts.fa2Iterations ?? 100 as the FA2 iterations value (backward-compatible default)", () => {
    expect(content).toContain("opts.fa2Iterations");
    expect(content).toContain("?? 100");
  });

  it("does not have the hardcoded iterations: 100 anymore (uses the opts parameter)", () => {
    // The old hardcoded value should now reference opts.fa2Iterations
    // Check the FA2 call uses the opts parameter, not a bare literal
    const fa2CallIndex = content.indexOf("forceAtlas2.assign");
    expect(fa2CallIndex).toBeGreaterThan(-1);
    // The iterations line after the forceAtlas2.assign call should reference opts
    const fa2Block = content.slice(fa2CallIndex, fa2CallIndex + 300);
    expect(fa2Block).toContain("opts.fa2Iterations");
  });
});

// ---------------------------------------------------------------------------
// GraphCanvas.svelte — must remain untouched
// ---------------------------------------------------------------------------

describe("GraphCanvas.svelte — untouched", () => {
  it("still imports from stores/graphData (store-coupled as before)", () => {
    const content = readFileSync(join(componentsDir, "GraphCanvas.svelte"), "utf-8");
    expect(content).toContain("stores/graphData");
  });

  it("still exports getApi() function", () => {
    const content = readFileSync(join(componentsDir, "GraphCanvas.svelte"), "utf-8");
    expect(content).toContain("export function getApi");
  });

  it("does NOT have fa2Iterations in its props", () => {
    const content = readFileSync(join(componentsDir, "GraphCanvas.svelte"), "utf-8");
    expect(content).not.toContain("fa2Iterations");
  });
});
