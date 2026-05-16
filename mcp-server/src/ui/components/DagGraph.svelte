<script lang="ts">
/**
 * DagGraph.svelte
 *
 * Sigma.js DAG visualization with hierarchical top-down layout.
 * Creates its own graphology Graph instance and Sigma renderer scoped
 * to a container div — does NOT reuse sigmaGraph.ts (which is designed
 * for force-directed codebase graphs with drag, zoom, filter, etc.).
 *
 * Canon principles:
 *   - compose-from-small-to-large: atom component composed into BuildDashboard
 *   - props-are-the-component-contract: accepts DagNode[] and DagEdge[], no store coupling
 *   - simplicity-first: no drag/zoom/filter API; fixed 300px height; just render
 */

import Graph from "graphology";
import Sigma from "sigma";
import { computeDagLayout } from "../lib/dag-layout.ts";
import type { DagNode, DagEdge } from "../stores/build-dashboard-types.ts";

interface DagGraphProps {
  nodes: DagNode[];
  edges: DagEdge[];
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { nodes, edges }: DagGraphProps = $props();
let container: HTMLDivElement;

$effect(() => {
  if (!container || nodes.length === 0) return;

  const graph = new Graph({ type: "directed" });
  const positions = computeDagLayout(nodes);

  // Add nodes with computed positions
  for (const node of nodes) {
    const pos = positions.get(node.id) ?? { x: 0, y: 0 };
    graph.addNode(node.id, {
      label: node.id,
      x: pos.x,
      y: pos.y,
      size: 12,
      color: "#6c8cff",
    });
  }

  // Add edges (directed: source is the dependency, target is the dependent)
  // Arrow points FROM dependency TO dependent (downward in the hierarchy)
  for (const edge of edges) {
    // Guard: only add edge if both endpoints exist in the graph
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.addEdge(edge.source, edge.target, {
        color: "rgba(255,255,255,0.2)",
        size: 1.5,
        type: "arrow",
      });
    }
  }

  // Create Sigma renderer
  const sigma = new Sigma(graph, container, {
    renderEdgeLabels: false,
    enableEdgeEvents: false,
    defaultEdgeType: "arrow",
    allowInvalidContainer: true,
  });

  // Cleanup: kill sigma and clear graph when effect re-runs or component unmounts
  return () => {
    sigma.kill();
    graph.clear();
  };
});
</script>

<div class="dag-container" bind:this={container}></div>

<style>
  .dag-container {
    width: 100%;
    height: 440px;
    border-radius: var(--radius, 12px);
    background: var(--bg-surface, rgba(255, 255, 255, 0.03));
    border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    transition: border-color 0.2s;
  }

  .dag-container:hover {
    border-color: rgba(255, 255, 255, 0.12);
  }
</style>
