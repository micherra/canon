/**
 * Graph node clustering — groups nodes by directory for large graphs.
 * When node count exceeds a threshold, collapses nodes into cluster
 * super-nodes that can be expanded on click.
 */

import type { GraphNode, GraphEdge } from "../stores/graphData";

export const CLUSTER_THRESHOLD = 80;

export interface ClusterNode extends GraphNode {
  isCluster: true;
  children: GraphNode[];
  clusterKey: string;
  expandedFileCount: number;
}

export interface ClusteredGraph {
  nodes: (GraphNode | ClusterNode)[];
  edges: GraphEdge[];
  clustered: boolean;
  clusterMap: Map<string, ClusterNode>;
  /** Maps original node ID → cluster key */
  nodeToCluster: Map<string, string>;
}

/**
 * Get the directory group key for a file path (first two segments).
 */
function dirKey(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length >= 2 ? parts.slice(0, 2).join("/") : parts[0] || ".";
}

/**
 * Determine the dominant layer in a group of nodes.
 */
function dominantLayer(nodes: GraphNode[]): string {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const layer = n.layer || "unknown";
    counts.set(layer, (counts.get(layer) || 0) + 1);
  }
  let best = "unknown";
  let bestCount = 0;
  for (const [layer, count] of counts) {
    if (count > bestCount) { best = layer; bestCount = count; }
  }
  return best;
}

/**
 * Cluster graph nodes by directory when the graph exceeds the threshold.
 * Small groups (≤3 files) are left unclustered.
 */
export function clusterGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): ClusteredGraph {
  if (nodes.length <= CLUSTER_THRESHOLD) {
    return {
      nodes,
      edges,
      clustered: false,
      clusterMap: new Map(),
      nodeToCluster: new Map(),
    };
  }

  // Group nodes by directory
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = dirKey(node.id);
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }

  const resultNodes: (GraphNode | ClusterNode)[] = [];
  const clusterMap = new Map<string, ClusterNode>();
  const nodeToCluster = new Map<string, string>();

  for (const [key, group] of groups) {
    if (group.length <= 3) {
      // Small groups stay as individual nodes
      resultNodes.push(...group);
    } else {
      // Create cluster super-node
      const totalViolations = group.reduce((sum, n) => sum + (n.violation_count || 0), 0);
      const hasChanged = group.some(n => n.changed);
      const cluster: ClusterNode = {
        id: `cluster:${key}`,
        layer: dominantLayer(group),
        violation_count: totalViolations,
        changed: hasChanged,
        isCluster: true,
        children: group,
        clusterKey: key,
        expandedFileCount: group.length,
      };
      resultNodes.push(cluster);
      clusterMap.set(key, cluster);
      for (const n of group) {
        nodeToCluster.set(n.id, key);
      }
    }
  }

  // Remap edges: replace clustered node IDs with cluster IDs
  const edgeSet = new Set<string>(); // dedup
  const resultEdges: GraphEdge[] = [];

  for (const edge of edges) {
    const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
    const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;

    const mappedSource = nodeToCluster.has(sourceId) ? `cluster:${nodeToCluster.get(sourceId)}` : sourceId;
    const mappedTarget = nodeToCluster.has(targetId) ? `cluster:${nodeToCluster.get(targetId)}` : targetId;

    // Skip self-loops (intra-cluster edges)
    if (mappedSource === mappedTarget) continue;

    const edgeKey = `${mappedSource}->${mappedTarget}`;
    if (edgeSet.has(edgeKey)) continue;
    edgeSet.add(edgeKey);

    resultEdges.push({ source: mappedSource, target: mappedTarget });
  }

  return {
    nodes: resultNodes,
    edges: resultEdges,
    clustered: true,
    clusterMap,
    nodeToCluster,
  };
}

/**
 * Expand a cluster: replace the cluster node with its children,
 * restore original edges for those children.
 */
export function expandCluster(
  current: ClusteredGraph,
  clusterKey: string,
  originalEdges: GraphEdge[],
): ClusteredGraph {
  const cluster = current.clusterMap.get(clusterKey);
  if (!cluster) return current;

  // Remove cluster node, add children
  const newNodes = current.nodes.filter(n => n.id !== `cluster:${clusterKey}`);
  newNodes.push(...cluster.children);

  // Update maps
  const newClusterMap = new Map(current.clusterMap);
  newClusterMap.delete(clusterKey);

  const newNodeToCluster = new Map(current.nodeToCluster);
  for (const child of cluster.children) {
    newNodeToCluster.delete(child.id);
  }

  // Rebuild edges from original
  const nodeIdSet = new Set(newNodes.map(n => n.id));
  const edgeSet = new Set<string>();
  const newEdges: GraphEdge[] = [];

  for (const edge of originalEdges) {
    const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
    const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;

    const mappedSource = newNodeToCluster.has(sourceId) ? `cluster:${newNodeToCluster.get(sourceId)}` : sourceId;
    const mappedTarget = newNodeToCluster.has(targetId) ? `cluster:${newNodeToCluster.get(targetId)}` : targetId;

    // Only include edges where both endpoints exist in the current node set
    if (!nodeIdSet.has(mappedSource) && !newClusterMap.has(mappedSource.replace("cluster:", ""))) continue;
    if (!nodeIdSet.has(mappedTarget) && !newClusterMap.has(mappedTarget.replace("cluster:", ""))) continue;

    if (mappedSource === mappedTarget) continue;

    const edgeKey = `${mappedSource}->${mappedTarget}`;
    if (edgeSet.has(edgeKey)) continue;
    edgeSet.add(edgeKey);

    newEdges.push({ source: mappedSource, target: mappedTarget });
  }

  return {
    nodes: newNodes,
    edges: newEdges,
    clustered: newClusterMap.size > 0,
    clusterMap: newClusterMap,
    nodeToCluster: newNodeToCluster,
  };
}
