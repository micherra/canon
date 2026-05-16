/**
 * dag-layout.ts
 *
 * Pure function: topological layer assignment for DAG nodes.
 * Uses Kahn's algorithm to assign each node a generation (Y layer),
 * then spreads nodes within each generation evenly across the X axis.
 *
 * Designed for small Canon task DAGs (typically 2–15 nodes).
 * No external dependencies.
 */

/** Position for a node in the 2D layout space. */
export type DagPosition = { x: number; y: number };

type NodeDescriptor = { id: string; depends_on: string[] };

/** Build in-degree map and successors map from the node list (ignores unknown deps). */
function buildGraph(
  nodes: NodeDescriptor[],
  nodeIds: Set<string>,
): { inDegree: Map<string, number>; successors: Map<string, string[]> } {
  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    successors.set(node.id, []);
  }
  for (const node of nodes) {
    for (const dep of node.depends_on) {
      if (nodeIds.has(dep)) {
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
        successors.get(dep)!.push(node.id);
      }
    }
  }
  return { inDegree, successors };
}

/** Process one layer of Kahn's algorithm: return the next layer given the current one. */
function nextKahnLayer(
  currentLayer: string[],
  processed: Set<string>,
  inDegree: Map<string, number>,
  successors: Map<string, string[]>,
): string[] {
  const nextLayer: string[] = [];
  for (const id of currentLayer) {
    for (const successor of successors.get(id) ?? []) {
      const newDegree = (inDegree.get(successor) ?? 0) - 1;
      inDegree.set(successor, newDegree);
      if (newDegree === 0 && !processed.has(successor)) {
        nextLayer.push(successor);
      }
    }
  }
  return nextLayer;
}

/** Run Kahn's algorithm and return nodes grouped into layers. */
function computeLayers(nodes: NodeDescriptor[], nodeIds: Set<string>): string[][] {
  const { inDegree, successors } = buildGraph(nodes, nodeIds);
  const layers: string[][] = [];
  const processed = new Set<string>();

  let currentLayer = nodes.filter((n) => inDegree.get(n.id) === 0).map((n) => n.id);

  while (currentLayer.length > 0) {
    layers.push(currentLayer);
    for (const id of currentLayer) {
      processed.add(id);
    }
    currentLayer = nextKahnLayer(currentLayer, processed, inDegree, successors);
  }

  // Fallback: any unprocessed nodes (cycles — should not occur in valid Canon DAGs)
  const unprocessed = nodes.filter((n) => !processed.has(n.id)).map((n) => n.id);
  if (unprocessed.length > 0) {
    layers.push(unprocessed);
  }

  return layers;
}

/**
 * Compute hierarchical positions for DAG nodes using topological layering.
 * Returns a Map from node ID to { x, y } coordinates suitable for graphology.
 *
 * Algorithm:
 * 1. Build in-degree and successor maps (only counting edges between known nodes).
 * 2. Kahn's algorithm: process nodes layer by layer starting from roots (in-degree 0).
 * 3. Assign Y = layer_index * layerSpacing.
 * 4. Center each layer: X = (node_index - (layer_size - 1) / 2) * nodeSpacing.
 * 5. Any nodes unreached (cycle remnants) are placed in a final fallback layer.
 *
 * @param nodes - Array of { id, depends_on } objects describing the DAG
 * @param layerSpacing - Vertical distance between layers (default: 150)
 * @param nodeSpacing - Horizontal distance between nodes in the same layer (default: 200)
 * @returns Map from node ID to { x, y } position
 */
export function computeDagLayout(
  nodes: Array<{ id: string; depends_on: string[] }>,
  layerSpacing = 150,
  nodeSpacing = 200,
): Map<string, DagPosition> {
  if (nodes.length === 0) return new Map();

  const nodeIds = new Set(nodes.map((n) => n.id));
  const layers = computeLayers(nodes, nodeIds);

  const positions = new Map<string, DagPosition>();
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layer = layers[layerIndex];
    const y = layerIndex * layerSpacing;
    for (let nodeIndex = 0; nodeIndex < layer.length; nodeIndex++) {
      const x = (nodeIndex - (layer.length - 1) / 2) * nodeSpacing;
      positions.set(layer[nodeIndex], { x, y });
    }
  }

  return positions;
}
