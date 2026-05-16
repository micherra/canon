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

/**
 * Compute hierarchical positions for DAG nodes using topological layering.
 * Returns a Map from node ID to { x, y } coordinates suitable for graphology.
 *
 * Algorithm:
 * 1. Build in-degree map from edges (only counting edges where both source
 *    and target exist in the node list).
 * 2. Kahn's algorithm: process nodes layer by layer starting from roots
 *    (nodes with in-degree 0).
 * 3. Assign Y = layer_index * layerSpacing.
 * 4. Center each layer: X = (node_index_in_layer - (layer_size - 1) / 2) * nodeSpacing.
 * 5. Any nodes unreached (cycle remnants or unknown dep targets) are placed
 *    in a final fallback layer at the bottom.
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

  // Build in-degree map — only count edges where both src and target are known
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
  }

  // adjacency: for each node, which nodes depend on it (successors)
  const successors = new Map<string, string[]>();
  for (const node of nodes) {
    successors.set(node.id, []);
  }

  for (const node of nodes) {
    for (const dep of node.depends_on) {
      if (nodeIds.has(dep)) {
        // node depends on dep → dep → node edge
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
        successors.get(dep)!.push(node.id);
      }
      // If dep is unknown, ignore the edge (treat node as having no in-degree from that dep)
    }
  }

  // Kahn's algorithm: process layer by layer
  const layers: string[][] = [];
  const processed = new Set<string>();

  // Start with all nodes whose in-degree is 0
  let currentLayer = nodes.filter((n) => inDegree.get(n.id) === 0).map((n) => n.id);

  while (currentLayer.length > 0) {
    layers.push(currentLayer);
    for (const id of currentLayer) {
      processed.add(id);
    }

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

    currentLayer = nextLayer;
  }

  // Any unprocessed nodes (should only happen with cycles, which Canon DAGs don't have)
  // Place them in a fallback layer at the bottom
  const unprocessed = nodes.filter((n) => !processed.has(n.id)).map((n) => n.id);
  if (unprocessed.length > 0) {
    layers.push(unprocessed);
  }

  // Assign coordinates
  const positions = new Map<string, DagPosition>();
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layer = layers[layerIndex];
    const y = layerIndex * layerSpacing;
    for (let nodeIndex = 0; nodeIndex < layer.length; nodeIndex++) {
      // Center the layer: spread nodes symmetrically around X=0
      const x = (nodeIndex - (layer.length - 1) / 2) * nodeSpacing;
      positions.set(layer[nodeIndex], { x, y });
    }
  }

  return positions;
}
