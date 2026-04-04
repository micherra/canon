<script lang="ts">
import { onDestroy } from "svelte";
import { buildSigmaGraph, type FilterOptions, type SigmaGraphApi } from "../lib/sigmaGraph";
import type { GraphEdge, GraphNode } from "../lib/types";

// ── Props interface ───────────────────────────────────────────────────────

interface SubGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  seedNodeIds: Set<string>;
  layerColors: Record<string, string>;
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
  fa2Iterations?: number;
  filterOptions?: FilterOptions | null;
}

let {
  nodes,
  edges,
  seedNodeIds,
  layerColors,
  onNodeClick,
  onBackgroundClick,
  fa2Iterations = 60,
  filterOptions = null,
}: SubGraphProps = $props();

// ── Internal state ───────────────────────────────────────────────────────

let container: HTMLDivElement;
let graphApi: SigmaGraphApi | undefined;

// ── $effect: rebuild graph when nodes/edges change ────────────────────────

$effect(() => {
  // Access reactive props so Svelte tracks them
  const currentNodes = nodes;
  const currentEdges = edges;
  const _currentSeedNodeIds = seedNodeIds;

  if (!container) return;

  // Destroy previous instance to release WebGL context
  if (graphApi) {
    graphApi.destroy();
    graphApi = undefined;
  }

  if (!currentNodes || currentNodes.length === 0) return;

  // ── Build edgeIn / edgeOut maps from provided edges ──────────────────
  // (same logic as the derived stores in graphData.ts, but computed locally
  //  from props — no store coupling)

  const edgeIn = new Map<string, string[]>();
  const edgeOut = new Map<string, string[]>();

  for (const edge of currentEdges) {
    const s = typeof edge.source === "string" ? edge.source : edge.source.id;
    const t = typeof edge.target === "string" ? edge.target : edge.target.id;

    if (!edgeOut.has(s)) edgeOut.set(s, []);
    edgeOut.get(s)!.push(t);

    if (!edgeIn.has(t)) edgeIn.set(t, []);
    edgeIn.get(t)!.push(s);
  }

  // ── Construct graph via buildSigmaGraph ──────────────────────────────

  graphApi = buildSigmaGraph(
    container,
    { nodes: currentNodes, edges: currentEdges },
    {
      onNodeClick,
      onBackgroundClick,
      edgeIn,
      edgeOut,
      layerColors,
      fa2Iterations,
    },
  );

  // NOTE: No cascade highlight on initial build for CodebaseGraph.
  // Changed nodes are already colored blue by the nodeReducer's default path.
  // Cascade highlighting is only used by SubGraph when embedded in PR Impact view
  // where an explicit highlightCascade call is made by the parent.
});

// ── $effect: apply filters when filterOptions changes (post-build only) ──

$effect(() => {
  const opts = filterOptions;
  if (!graphApi) return;

  if (opts) {
    graphApi.applyFilters(opts);
  } else {
    // Filters cleared — reset all state and return to default (natural colors) view.
    graphApi.resetView();
  }
});

// ── Cleanup: destroy Sigma instance to release WebGL context ─────────────

onDestroy(() => {
  graphApi?.destroy();
});
</script>

<div class="subgraph-canvas">
  <div class="subgraph-sigma" bind:this={container}></div>
</div>

<style>
  .subgraph-canvas {
    width: 100%;
    height: 100%;
    background: transparent;
    overflow: hidden;
    position: relative;
  }
  .subgraph-sigma {
    width: 100%;
    height: 100%;
  }
</style>
