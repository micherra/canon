/**
 * Knowledge Graph Insight Computation Helpers
 *
 * Extracted from kg-query.ts — pure computation helpers for hub detection,
 * cycle membership, and layer violation analysis. No mutations, no state.
 */

import { LAYER_CENTRALITY } from "@shared/constants.ts";
import type Database from "better-sqlite3";
import type { LayerViolation } from "./kg-types.ts";

// Layer rules — clean-architecture defaults (mirrors insights.ts)

/** Compute impact score for a file based on graph position. Higher = more impactful. */
export function computeImpactScore(
  inDegree: number,
  violationCount: number,
  isChanged: boolean,
  layer: string,
): number {
  const centrality = LAYER_CENTRALITY[layer] ?? 0;
  const score = inDegree * 3 + violationCount * 2 + (isChanged ? 1 : 0) + centrality;
  return Math.round(score * 100) / 100;
}

export const DEFAULT_LAYER_RULES: Record<string, string[]> = {
  api: ["domain", "shared", "data"],
  data: ["infra", "shared"],
  domain: ["data", "shared"],
  infra: ["shared"],
  shared: [],
  ui: ["domain", "shared"],
};

export type FileInsightMaps = {
  /** Set of file paths that qualify as hubs (top 10 by total degree). */
  hubPaths: Set<string>;
  /** Map from file path to the set of cycle-peer paths. */
  cycleMemberPaths: Map<string, string[]>;
  /** Map from file path to its outbound layer violations. */
  layerViolationsByPath: Map<string, LayerViolation[]>;
};

export type FileEdgeRow = {
  source_file_id: number;
  target_file_id: number;
  source_path: string;
  target_path: string;
  source_layer: string;
  target_layer: string;
};

/** Compute hub paths from degree maps (top 10 by total degree). */
export function computeHubPaths(edgeRows: FileEdgeRow[]): Set<string> {
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  for (const row of edgeRows) {
    outDegree.set(row.source_path, (outDegree.get(row.source_path) || 0) + 1);
    inDegree.set(row.target_path, (inDegree.get(row.target_path) || 0) + 1);
  }

  const allPaths = new Set([...inDegree.keys(), ...outDegree.keys()]);
  const sorted = [...allPaths]
    .map((p) => ({ path: p, total: (inDegree.get(p) || 0) + (outDegree.get(p) || 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  return new Set(sorted.map((x) => x.path));
}

/** Build adjacency list from file edge rows. */
export function buildFileAdjacency(edgeRows: FileEdgeRow[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const row of edgeRows) {
    let neighbors = adj.get(row.source_path);
    if (!neighbors) {
      neighbors = [];
      adj.set(row.source_path, neighbors);
    }
    neighbors.push(row.target_path);
  }
  return adj;
}

/** Compute layer violations from file edge rows. */
export function computeLayerViolations(edgeRows: FileEdgeRow[]): Map<string, LayerViolation[]> {
  const violations = new Map<string, LayerViolation[]>();
  const rules = DEFAULT_LAYER_RULES;

  for (const row of edgeRows) {
    const sourceLayer = row.source_layer || "unknown";
    const targetLayer = row.target_layer || "unknown";

    if (sourceLayer === targetLayer || sourceLayer === "unknown" || targetLayer === "unknown") {
      continue;
    }

    const allowed = rules[sourceLayer];
    if (allowed && !allowed.includes(targetLayer)) {
      let list = violations.get(row.source_path);
      if (!list) {
        list = [];
        violations.set(row.source_path, list);
      }
      list.push({ source_layer: sourceLayer, target: row.target_path, target_layer: targetLayer });
    }
  }
  return violations;
}

export function computeFileInsightMaps(db: Database.Database): FileInsightMaps {
  const edgeRows = db
    .prepare(`SELECT fe.source_file_id, fe.target_file_id, fs.path AS source_path, ft.path AS target_path,
                     fs.layer AS source_layer, ft.layer AS target_layer
              FROM file_edges fe
              JOIN files fs ON fs.file_id = fe.source_file_id
              JOIN files ft ON ft.file_id = fe.target_file_id`)
    .all() as FileEdgeRow[];

  const hubPaths = computeHubPaths(edgeRows);
  const adj = buildFileAdjacency(edgeRows);

  const fileRows = db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>;
  const cycleMemberPaths = detectFileCycles(
    fileRows.map((r) => r.path),
    adj,
  );
  const layerViolationsByPath = computeLayerViolations(edgeRows);

  return { cycleMemberPaths, hubPaths, layerViolationsByPath };
}

// Cycle detection helpers (file-level DFS — mirrors insights.ts pattern)

/** Build a membership map from detected cycles: node → peer nodes in its cycles. */
function buildCycleMembershipMap(cycles: string[][]): Map<string, string[]> {
  const members = new Map<string, string[]>();
  for (const cycle of cycles) {
    for (const node of cycle) {
      const existing = members.get(node) || [];
      for (const peer of cycle) {
        if (peer !== node && !existing.includes(peer)) existing.push(peer);
      }
      members.set(node, existing);
    }
  }
  return members;
}

export function detectFileCycles(
  nodes: string[],
  adj: Map<string, string[]>,
): Map<string, string[]> {
  const collector: FileCycleCollector = {
    cycleSet: new Set<string>(),
    cycles: [],
    maxLen: 5,
  };
  const visited = new Set<string>();
  const ctx: FileDfsContext = { adj, collector, maxCycles: 20, visited };

  for (const startNode of nodes) {
    if (visited.has(startNode) || collector.cycles.length >= 20) continue;
    fileDfsComponent(startNode, ctx);
  }

  return buildCycleMembershipMap(collector.cycles);
}

export type FileCycleCollector = {
  maxLen: number;
  cycleSet: Set<string>;
  cycles: string[][];
};

/** Try to record a file-level cycle from the current DFS path. */
function tryRecordFileCycle(neighbor: string, path: string[], collector: FileCycleCollector): void {
  const cycleStart = path.indexOf(neighbor);
  if (cycleStart < 0) return;
  const cycle = path.slice(cycleStart);
  if (cycle.length > collector.maxLen) return;
  const normalized = fileNormalizeCycle(cycle);
  const key = normalized.join(" -> ");
  if (collector.cycleSet.has(key)) return;
  collector.cycleSet.add(key);
  collector.cycles.push(normalized);
}

type FileDfsContext = {
  adj: Map<string, string[]>;
  visited: Set<string>;
  collector: FileCycleCollector;
  maxCycles: number;
};

export function fileDfsComponent(startNode: string, ctx: FileDfsContext): void {
  type Frame = { node: string; neighborIdx: number };

  const { adj, visited, collector, maxCycles } = ctx;
  const inStack = new Set<string>();
  const path: string[] = [];
  const callStack: Frame[] = [{ neighborIdx: 0, node: startNode }];
  visited.add(startNode);
  inStack.add(startNode);
  path.push(startNode);

  while (callStack.length > 0 && collector.cycles.length < maxCycles) {
    const frame = callStack[callStack.length - 1];
    const neighbors = adj.get(frame.node) || [];

    if (frame.neighborIdx >= neighbors.length) {
      callStack.pop();
      path.pop();
      inStack.delete(frame.node);
      continue;
    }

    const neighbor = neighbors[frame.neighborIdx];
    frame.neighborIdx++;

    if (inStack.has(neighbor)) {
      tryRecordFileCycle(neighbor, path, collector);
    } else if (!visited.has(neighbor)) {
      visited.add(neighbor);
      inStack.add(neighbor);
      path.push(neighbor);
      callStack.push({ neighborIdx: 0, node: neighbor });
    }
  }

  for (const node of path) inStack.delete(node);
}

export function fileNormalizeCycle(cycle: string[]): string[] {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}

// Helper — SQLite returns 0/1 for booleans; coerce to boolean
import type { EntityRow } from "./kg-types.ts";

export function toEntityRow(row: Record<string, unknown>): EntityRow {
  return {
    ...(row as unknown as EntityRow),
    is_default_export: Boolean(row.is_default_export),
    is_exported: Boolean(row.is_exported),
  };
}
