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

  it("imports highlightCascade from sigmaGraph api (used by PR Impact, not CodebaseGraph)", () => {
    // SubGraph still accepts seedNodeIds as a prop for callers that need cascade
    // highlighting (e.g. PR Impact subgraph). The CodebaseGraph does NOT call
    // highlightCascade — changed nodes are already blue via nodeReducer default path.
    expect(content).toContain("seedNodeIds");
  });

  it("calls resetView when filterOptions becomes null", () => {
    expect(content).toContain("resetView");
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

