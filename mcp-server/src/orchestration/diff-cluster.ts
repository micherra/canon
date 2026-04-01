/**
 * Diff clustering — groups changed files into clusters for parallel fan-out.
 * Used when a state declares large_diff_threshold + cluster_by to split
 * large diffs across multiple parallel agent spawns.
 */

import { dirname } from "node:path";
import { gitExec } from "../adapters/git-adapter.ts";
import { inferLayer } from "../matcher.ts";

export interface FileCluster {
  key: string;
  files: string[];
}

const BASE_COMMIT_RE = /^[a-f0-9]{7,40}$/;

/**
 * Get the list of changed files since the base commit.
 */
export function getChangedFiles(baseCommit: string, cwd?: string): string[] {
  if (!BASE_COMMIT_RE.test(baseCommit)) return [];

  const result = gitExec(["diff", "--name-only", `${baseCommit}..HEAD`], cwd ?? process.cwd());
  if (!result.ok) return [];
  return result.stdout.trim().split("\n").filter(Boolean);
}

/**
 * Cluster files by their parent directory (first two segments).
 * e.g., "src/api/orders.ts" → "src/api"
 */
export function clusterByDirectory(files: string[]): FileCluster[] {
  const groups = new Map<string, string[]>();

  for (const file of files) {
    const dir = dirname(file);
    // Use first two path segments as the group key for reasonable granularity
    const parts = dir.split("/");
    const key = parts.length >= 2 ? parts.slice(0, 2).join("/") : parts[0];
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }

  return Array.from(groups.entries())
    .map(([key, files]) => ({ key, files }))
    .sort((a, b) => b.files.length - a.files.length);
}

/**
 * Cluster files by their inferred Canon layer (api, ui, domain, data, etc.).
 */
export function clusterByLayer(files: string[]): FileCluster[] {
  const groups = new Map<string, string[]>();

  for (const file of files) {
    const layer = inferLayer(file) ?? "unknown";
    const group = groups.get(layer) ?? [];
    group.push(file);
    groups.set(layer, group);
  }

  return Array.from(groups.entries())
    .map(([key, files]) => ({ key, files }))
    .sort((a, b) => b.files.length - a.files.length);
}

/**
 * Determine whether the diff exceeds the threshold and return clusters if so.
 * Returns null if the threshold is not exceeded (no clustering needed).
 */
export function clusterDiff(
  baseCommit: string,
  threshold: number,
  strategy: "directory" | "layer",
): FileCluster[] | null {
  const files = getChangedFiles(baseCommit);
  if (files.length <= threshold) return null;

  return strategy === "layer"
    ? clusterByLayer(files)
    : clusterByDirectory(files);
}
