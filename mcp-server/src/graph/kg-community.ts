/**
 * Knowledge Graph Community Detection
 *
 * Builds a graphology Graph from the file-level adjacency list, runs the
 * Louvain algorithm, and writes community_id back to the files table.
 *
 * This is a pure function module — no class, no state.
 */

// graphology-types is a peer dependency that is not installed separately;
// constructor options are passed via `as any` cast (see detectCommunities).
import GraphCtor from "graphology";
import louvain from "graphology-communities-louvain";
import type { KgStore } from "./kg-store.ts";

// Minimal interface for the graphology Graph operations we use.
// This avoids importing the full graphology type chain (which requires
// graphology-types as a separate installed package).
type GraphInstance = {
  order: number;
  addNode(key: string): void;
  hasEdge(source: string, target: string): boolean;
  addEdge(source: string, target: string): void;
  forEachNode(callback: (key: string, attrs: Record<string, unknown>) => void): void;
};

/** Result of a community detection run. */
export type CommunityResult = {
  /** Number of distinct communities detected (0 when no files exist). */
  communityCount: number;
  /** Number of files assigned to a community (graph node count). */
  filesAssigned: number;
};

/**
 * Run Louvain community detection on the file-level import graph.
 *
 * Reads adjacency data from the provided map (typically from
 * `KgQuery.getFileAdjacencyList()`), builds an undirected graphology Graph,
 * runs `louvain.assign()`, then writes `community_id` back to the files table
 * via `store.updateCommunityId()` inside a transaction.
 *
 * @param adjacencyList - Map from source file_id to array of target file_ids.
 *   Both source and target IDs must correspond to rows in the files table.
 * @param store - KgStore instance used to persist community assignments.
 * @returns Result with `communityCount` and `filesAssigned`.
 *   Returns `{ communityCount: 0, filesAssigned: 0 }` when the map is empty.
 */
export function detectCommunities(
  adjacencyList: Map<number, number[]>,
  store: KgStore,
): CommunityResult {
  // Clear stale community assignments from previous runs so that files no
  // longer in the adjacency graph do not retain their old community_id.
  store.clearAllCommunityIds();

  // Build undirected graphology Graph from adjacency list
  // biome-ignore lint/suspicious/noExplicitAny: graphology-types not installed; cast via any to pass options
  const graph = new (GraphCtor as any)({ type: "undirected" }) as GraphInstance;

  // Collect all file IDs (both sources and targets)
  const allFileIds = new Set<number>();
  for (const [source, targets] of adjacencyList) {
    allFileIds.add(source);
    for (const target of targets) {
      allFileIds.add(target);
    }
  }

  // Early exit — no files to process
  if (allFileIds.size === 0) {
    return { communityCount: 0, filesAssigned: 0 };
  }

  // Add nodes
  for (const fileId of allFileIds) {
    graph.addNode(String(fileId));
  }

  // Add edges (skip duplicates — graphology throws on duplicate edges)
  for (const [source, targets] of adjacencyList) {
    for (const target of targets) {
      const srcStr = String(source);
      const tgtStr = String(target);
      if (!graph.hasEdge(srcStr, tgtStr)) {
        graph.addEdge(srcStr, tgtStr);
      }
    }
  }

  // Run Louvain — assigns `community` attribute to each node
  louvain.assign(graph, { nodeCommunityAttribute: "community" });

  // Write community_id back to files table in a single transaction
  const communities = new Set<number>();
  store.transaction(() => {
    graph.forEachNode((nodeId: string, attrs: Record<string, unknown>) => {
      const fileId = Number(nodeId);
      const communityId = attrs.community as number;
      communities.add(communityId);
      store.updateCommunityId(fileId, communityId);
    });
  });

  return { communityCount: communities.size, filesAssigned: graph.order };
}
