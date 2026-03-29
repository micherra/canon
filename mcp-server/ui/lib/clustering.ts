/**
 * clustering.ts
 *
 * Pure client-side clustering algorithm for PR change story cards.
 * Groups changed files into coherent narrative clusters.
 *
 * Decision: prv2-02 — clustering is a pure client-side function,
 * zero backend coupling, independently testable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterInput {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  layer: string;
}

export interface Cluster {
  id: string;
  title: string;
  type: "new-feature" | "removal" | "prefix-group" | "layer-group" | "other";
  description: string;
  files: ClusterInput[];
}

// ---------------------------------------------------------------------------
// Helpers — each does one thing
// ---------------------------------------------------------------------------

/**
 * Extracts the basename from a path (last path segment, minus extension).
 */
function basename(filePath: string): string {
  const parts = filePath.split("/");
  const last = parts[parts.length - 1];
  return last;
}

/**
 * Extracts the directory portion of a path (everything before the last "/").
 */
function dirOf(filePath: string): string {
  const parts = filePath.split("/");
  return parts.slice(0, -1).join("/");
}

/**
 * Converts a string into a URL-safe slug for use as a cluster id.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Finds the common prefix (up to a separator: `-`, `_`, or `.`) shared by all
 * filenames. Returns the prefix including the separator, or null if none found.
 *
 * Examples:
 *   ["kg-store.ts", "kg-query.ts"] → "kg-"
 *   ["pr-review-data.ts", "pr-review-prep.ts"] → "pr-"
 *   ["store.ts", "query.ts"] → null
 *   ["kg-store.ts"] → null (need >= 2 files)
 */
export function findCommonPrefix(filenames: string[]): string | null {
  if (filenames.length < 2) return null;

  const separators = ["-", "_", "."];

  // For each file, extract all prefix candidates (prefix up to each separator occurrence)
  function prefixCandidates(name: string): string[] {
    const candidates: string[] = [];
    for (const sep of separators) {
      const idx = name.indexOf(sep);
      if (idx > 0) {
        candidates.push(name.slice(0, idx + 1));
      }
    }
    return candidates;
  }

  // Collect candidates from first file and check if all others share it
  const firstCandidates = prefixCandidates(filenames[0]);
  for (const candidate of firstCandidates) {
    if (filenames.every((f) => f.startsWith(candidate))) {
      return candidate;
    }
  }

  return null;
}

/**
 * Groups files into a map keyed by directory path.
 */
function groupByDirectory(files: ClusterInput[]): Map<string, ClusterInput[]> {
  const map = new Map<string, ClusterInput[]>();
  for (const file of files) {
    const dir = dirOf(file.path);
    const existing = map.get(dir) ?? [];
    existing.push(file);
    map.set(dir, existing);
  }
  return map;
}

/**
 * Synthesizes a 1-2 sentence description from a list of files and their statuses.
 * Pure — no side effects.
 */
export function synthesizeDescription(files: ClusterInput[]): string {
  if (files.length === 0) return "No files.";

  const added = files.filter((f) => f.status === "added").length;
  const deleted = files.filter((f) => f.status === "deleted").length;
  const modified = files.filter((f) => f.status === "modified" || f.status === "renamed").length;

  const parts: string[] = [];
  if (added > 0) parts.push(`${added} file${added > 1 ? "s" : ""} added`);
  if (modified > 0) parts.push(`${modified} file${modified > 1 ? "s" : ""} modified`);
  if (deleted > 0) parts.push(`${deleted} file${deleted > 1 ? "s" : ""} deleted`);

  // Sample up to 3 basenames for context
  const sample = files
    .slice(0, 3)
    .map((f) => basename(f.path).replace(/\.(ts|js|svelte|py|sh|yaml|yml|md)$/, ""))
    .join(", ");

  return `${parts.join(", ")}. Includes: ${sample}${files.length > 3 ? ", and more" : ""}.`;
}

/**
 * Returns an icon character for a cluster type.
 *
 * - new-feature  → ✓ (check)
 * - removal      → ✗ (X)
 * - prefix-group → ⏱ (clock)
 * - layer-group  → ⚠ (warning)
 * - other        → ⚠ (warning)
 */
export function clusterIcon(type: Cluster["type"]): string {
  switch (type) {
    case "new-feature":  return "✓";
    case "removal":      return "✗";
    case "prefix-group": return "⏱";
    case "layer-group":  return "⚠";
    case "other":        return "⚠";
  }
}

// ---------------------------------------------------------------------------
// Clustering steps (each step operates on remaining unclustered files)
// ---------------------------------------------------------------------------

/**
 * Step 1: New feature clusters.
 * Groups files by directory. If ALL files in that directory have status "added",
 * creates a "new-feature" cluster.
 */
function clusterNewFeatures(
  files: ClusterInput[],
): { clusters: Cluster[]; remaining: ClusterInput[] } {
  const byDir = groupByDirectory(files);
  const clusters: Cluster[] = [];
  const clustered = new Set<string>();

  for (const [dir, dirFiles] of byDir) {
    if (dirFiles.length >= 2 && dirFiles.every((f) => f.status === "added")) {
      const label = dir.split("/").pop() ?? dir;
      clusters.push({
        id: slugify(`new-${label}`),
        title: `New: ${label}`,
        type: "new-feature",
        description: synthesizeDescription(dirFiles),
        files: dirFiles,
      });
      for (const f of dirFiles) clustered.add(f.path);
    }
  }

  const remaining = files.filter((f) => !clustered.has(f.path));
  return { clusters, remaining };
}

/**
 * Step 2: Removal clusters.
 * Groups files by directory. If ALL files in that directory have status "deleted",
 * creates a "removal" cluster.
 */
function clusterRemovals(
  files: ClusterInput[],
): { clusters: Cluster[]; remaining: ClusterInput[] } {
  const byDir = groupByDirectory(files);
  const clusters: Cluster[] = [];
  const clustered = new Set<string>();

  for (const [dir, dirFiles] of byDir) {
    if (dirFiles.length >= 2 && dirFiles.every((f) => f.status === "deleted")) {
      const label = dir.split("/").pop() ?? dir;
      clusters.push({
        id: slugify(`removed-${label}`),
        title: `Removed: ${label}`,
        type: "removal",
        description: synthesizeDescription(dirFiles),
        files: dirFiles,
      });
      for (const f of dirFiles) clustered.add(f.path);
    }
  }

  const remaining = files.filter((f) => !clustered.has(f.path));
  return { clusters, remaining };
}

/**
 * Step 3: Prefix groups.
 * Within each directory, finds files sharing a common filename prefix
 * (e.g. kg-, pr-). Creates a named cluster for each prefix group >= 2 files.
 *
 * Algorithm:
 * 1. Compute the pairwise prefix between every pair of files in the directory.
 * 2. Build a map from prefix → all files whose basename starts with that prefix.
 * 3. Pick the prefix that covers the most files; emit as a cluster.
 * 4. Repeat for remaining files until no prefix group of >= 2 exists.
 */
function clusterByPrefix(
  files: ClusterInput[],
): { clusters: Cluster[]; remaining: ClusterInput[] } {
  const byDir = groupByDirectory(files);
  const clusters: Cluster[] = [];
  const clustered = new Set<string>();

  for (const [dir, dirFiles] of byDir) {
    let unclustered = [...dirFiles];

    // Iteratively find the best prefix group until none remain
    let found = true;
    while (found && unclustered.length >= 2) {
      found = false;

      // Build candidate prefix → files map
      const prefixMap = new Map<string, ClusterInput[]>();

      for (let i = 0; i < unclustered.length; i++) {
        for (let j = i + 1; j < unclustered.length; j++) {
          const nameI = basename(unclustered[i].path);
          const nameJ = basename(unclustered[j].path);
          const prefix = findCommonPrefix([nameI, nameJ]);
          if (!prefix) continue;

          // Collect ALL files starting with this prefix
          if (!prefixMap.has(prefix)) {
            const group = unclustered.filter((f) => basename(f.path).startsWith(prefix));
            prefixMap.set(prefix, group);
          }
        }
      }

      if (prefixMap.size === 0) break;

      // Pick the prefix with the most files (greedy)
      let bestPrefix = "";
      let bestGroup: ClusterInput[] = [];
      for (const [prefix, group] of prefixMap) {
        if (group.length > bestGroup.length) {
          bestPrefix = prefix;
          bestGroup = group;
        }
      }

      if (bestGroup.length >= 2) {
        const label = bestPrefix.replace(/[-_.]$/, "");
        clusters.push({
          id: slugify(`prefix-${dir}-${label}`),
          title: `${label} files`,
          type: "prefix-group",
          description: synthesizeDescription(bestGroup),
          files: bestGroup,
        });
        for (const f of bestGroup) clustered.add(f.path);
        unclustered = unclustered.filter((f) => !clustered.has(f.path));
        found = true;
      }
    }
  }

  const remaining = files.filter((f) => !clustered.has(f.path));
  return { clusters, remaining };
}

/**
 * Step 4: Layer groups.
 * Remaining files grouped by layer. Creates one cluster per layer
 * if the layer has >= 2 files.
 */
function clusterByLayer(
  files: ClusterInput[],
): { clusters: Cluster[]; remaining: ClusterInput[] } {
  const byLayer = new Map<string, ClusterInput[]>();
  for (const file of files) {
    const existing = byLayer.get(file.layer) ?? [];
    existing.push(file);
    byLayer.set(file.layer, existing);
  }

  const clusters: Cluster[] = [];
  const clustered = new Set<string>();

  for (const [layer, layerFiles] of byLayer) {
    if (layerFiles.length >= 2) {
      clusters.push({
        id: slugify(`layer-${layer}`),
        title: `${layer} changes`,
        type: "layer-group",
        description: synthesizeDescription(layerFiles),
        files: layerFiles,
      });
      for (const f of layerFiles) clustered.add(f.path);
    }
  }

  const remaining = files.filter((f) => !clustered.has(f.path));
  return { clusters, remaining };
}

/**
 * Step 5: Merge small clusters (< 2 files) into a single "Other modifications" cluster.
 */
function mergeSmallClusters(clusters: Cluster[], orphans: ClusterInput[]): Cluster[] {
  const small = clusters.filter((c) => c.files.length < 2);
  const large = clusters.filter((c) => c.files.length >= 2);

  const allSmallFiles = [
    ...small.flatMap((c) => c.files),
    ...orphans,
  ];

  if (allSmallFiles.length === 0) return large;

  const otherCluster: Cluster = {
    id: "other-modifications",
    title: "Other modifications",
    type: "other",
    description: synthesizeDescription(allSmallFiles),
    files: allSmallFiles,
  };

  return [...large, otherCluster];
}

/**
 * Step 6: Split large clusters (> 30 files) by subdirectory.
 * If all files share the same directory (no subdirectory variation), splits
 * into chunks of 30 files each.
 */
function splitLargeClusters(clusters: Cluster[]): Cluster[] {
  const result: Cluster[] = [];

  for (const cluster of clusters) {
    if (cluster.files.length <= 30) {
      result.push(cluster);
      continue;
    }

    // Try to split by subdirectory
    const bySubdir = groupByDirectory(cluster.files);

    if (bySubdir.size > 1) {
      // Multiple subdirectories — split by subdirectory
      for (const [subdir, subdirFiles] of bySubdir) {
        const label = subdir.split("/").pop() ?? subdir;
        // Recursively split if a subdirectory chunk is also > 30
        const sub: Cluster = {
          id: slugify(`${cluster.id}-${label}`),
          title: `${cluster.title} / ${label}`,
          type: cluster.type,
          description: synthesizeDescription(subdirFiles),
          files: subdirFiles,
        };
        if (subdirFiles.length > 30) {
          result.push(...splitLargeClusters([sub]));
        } else {
          result.push(sub);
        }
      }
    } else {
      // All in one directory — split into chunks of 30
      const chunkSize = 30;
      let part = 1;
      for (let i = 0; i < cluster.files.length; i += chunkSize) {
        const chunk = cluster.files.slice(i, i + chunkSize);
        result.push({
          id: slugify(`${cluster.id}-part-${part}`),
          title: `${cluster.title} (${part})`,
          type: cluster.type,
          description: synthesizeDescription(chunk),
          files: chunk,
        });
        part++;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Groups a flat list of changed files into coherent change story clusters.
 *
 * Algorithm:
 * 1. New-feature clusters — all-added directory subtrees
 * 2. Removal clusters — all-deleted directory subtrees
 * 3. Prefix groups — files sharing a common filename prefix within a directory
 * 4. Layer groups — remaining files grouped by layer
 * 5. Merge small clusters (< 2 files) into "Other modifications"
 * 6. Split large clusters (> 30 files) by subdirectory
 *
 * Pure function: takes array in, returns array out, never mutates input.
 */
export function clusterFiles(files: ClusterInput[]): Cluster[] {
  if (files.length === 0) return [];

  // Step 1: New features
  const step1 = clusterNewFeatures(files);
  let clusters = step1.clusters;
  let remaining = step1.remaining;

  // Step 2: Removals
  const step2 = clusterRemovals(remaining);
  clusters = [...clusters, ...step2.clusters];
  remaining = step2.remaining;

  // Step 3: Prefix groups
  const step3 = clusterByPrefix(remaining);
  clusters = [...clusters, ...step3.clusters];
  remaining = step3.remaining;

  // Step 4: Layer groups
  const step4 = clusterByLayer(remaining);
  clusters = [...clusters, ...step4.clusters];
  remaining = step4.remaining;

  // Step 5: Merge small clusters and orphans
  clusters = mergeSmallClusters(clusters, remaining);

  // Step 6: Split large clusters
  clusters = splitLargeClusters(clusters);

  return clusters;
}
