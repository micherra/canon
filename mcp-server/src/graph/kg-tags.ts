/**
 * Knowledge Graph Tag Propagation
 *
 * Computes file tags from four signal sources and persists them to file_tags.
 * Each source is a pure function returning FileTagRow[] — no side effects.
 * The orchestrating `propagateAllTags` function clears existing tags and calls
 * all four sources in sequence via bulkUpsertFileTags.
 */

import type { KgQuery } from "./kg-query.ts";
import type { KgStore } from "./kg-store.ts";
import type { FileTagRow } from "./kg-types.ts";

// --- Configuration ---

/**
 * Threshold for community tag propagation: a tag must appear on more than
 * this fraction of community members to be propagated to remaining members.
 * Magic number extracted as a named constant for future tuning.
 */
export const COMMUNITY_TAG_THRESHOLD = 0.5;

/**
 * Directory-to-tag mapping. Each entry specifies a path substring and the tag
 * to assign when a file's path contains that substring.
 * Using a configurable mapping array instead of hardcoded if/else chains.
 */
const DIRECTORY_TAG_MAPPINGS: Array<{ pathSubstring: string; tag: string }> = [
  { pathSubstring: "graph/", tag: "graph-infrastructure" },
  { pathSubstring: "features/orchestration/", tag: "orchestration" },
  { pathSubstring: "features/principles/", tag: "principles" },
  { pathSubstring: "features/pr-review/", tag: "pr-review" },
  { pathSubstring: "features/file-context/", tag: "file-context" },
  { pathSubstring: "features/knowledge-graph/", tag: "knowledge-graph" },
  { pathSubstring: "features/diagnostics/", tag: "diagnostics" },
  { pathSubstring: "platform/", tag: "infrastructure" },
  { pathSubstring: "shared/", tag: "shared-kernel" },
  { pathSubstring: "ui/", tag: "frontend" },
];

/**
 * Import-pattern-to-tag mapping. Each entry specifies a path substring that,
 * when matched against an imported file's path, assigns a tag to the importer.
 */
const IMPORT_TAG_MAPPINGS: Array<{ pathSubstring: string; tag: string }> = [
  { pathSubstring: "lib/errors.ts", tag: "error-handling" },
  { pathSubstring: "lib/tool-result.ts", tag: "error-handling" },
  { pathSubstring: "drift/", tag: "observability" },
  { pathSubstring: "kg-schema.ts", tag: "graph-infrastructure" },
  { pathSubstring: "kg-store.ts", tag: "graph-infrastructure" },
  { pathSubstring: "kg-query.ts", tag: "graph-infrastructure" },
  { pathSubstring: "parser.ts", tag: "principles" },
  { pathSubstring: "matcher.ts", tag: "principles" },
];

// --- Hub threshold ---

/**
 * Files with in-degree at or above this value are tagged as hubs.
 * Also, files in the top 10% of in-degree get the hub tag.
 */
const HUB_IN_DEGREE_THRESHOLD = 8;

// --- Result type ---

/**
 * Summary of a full tag propagation run, broken down by signal source.
 */
export type TagPropagationResult = {
  /** Total number of tag rows written across all sources. */
  totalTags: number;
  /** Count of tags written per source key. */
  bySource: Record<string, number>;
};

// --- Signal source functions ---

/**
 * Compute directory-derived tags for all files.
 *
 * Maps directory path segments to tags using `DIRECTORY_TAG_MAPPINGS`.
 * Returns one FileTagRow per (file, matching pattern) combination.
 *
 * @param query - KgQuery instance for read-only file access.
 * @returns Array of FileTagRow with source="directory" and confidence=1.0.
 */
export function computeDirectoryTags(query: KgQuery): FileTagRow[] {
  const allFiles = query.getAllFilesWithStats();
  const result: FileTagRow[] = [];

  for (const file of allFiles) {
    if (file.file_id === undefined) continue;
    for (const { pathSubstring, tag } of DIRECTORY_TAG_MAPPINGS) {
      if (file.path.includes(pathSubstring)) {
        result.push({
          confidence: 1.0,
          file_id: file.file_id,
          source: "directory",
          tag,
        });
      }
    }
  }

  return result;
}

/**
 * Collect tags triggered by a single imported file path.
 * Returns tags from IMPORT_TAG_MAPPINGS that match the target path.
 */
function tagsForImportedFile(targetPath: string): string[] {
  const tags: string[] = [];
  for (const { pathSubstring, tag } of IMPORT_TAG_MAPPINGS) {
    if (targetPath.includes(pathSubstring)) {
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * Collect all import-derived tags for one file, deduplicating across edges.
 */
function collectImportTagsForFile(fileId: number, store: KgStore): Set<string> {
  const tagSet = new Set<string>();
  const outEdges = store.getFileEdgesFrom(fileId);
  for (const edge of outEdges) {
    const targetFile = store.getFileById(edge.target_file_id);
    if (!targetFile) continue;
    for (const tag of tagsForImportedFile(targetFile.path)) {
      tagSet.add(tag);
    }
  }
  return tagSet;
}

/**
 * Compute import-derived tags for all files.
 *
 * For each file, inspects its outgoing file_edges (what it imports).
 * When an imported file's path matches a known utility pattern, assigns a tag
 * to the importing file.
 *
 * @param store - KgStore instance used to read file edges per file.
 * @param query - KgQuery instance for reading all files.
 * @returns Array of FileTagRow with source="import" and confidence=0.8.
 */
export function computeImportDerivedTags(store: KgStore, query: KgQuery): FileTagRow[] {
  const allFiles = query.getAllFilesWithStats();
  const result: FileTagRow[] = [];

  for (const file of allFiles) {
    if (file.file_id === undefined) continue;
    const tags = collectImportTagsForFile(file.file_id, store);
    for (const tag of tags) {
      result.push({
        confidence: 0.8,
        file_id: file.file_id,
        source: "import",
        tag,
      });
    }
  }

  return result;
}

/**
 * Compute graph-role-derived tags for all files.
 *
 * Uses in-degree and out-degree to classify files:
 * - in_degree >= HUB_IN_DEGREE_THRESHOLD OR top 10% by in-degree → "hub"
 * - in_degree === 0 → "entry-point"
 * - out_degree === 0 → "leaf"
 *
 * @param query - KgQuery instance for degree data.
 * @returns Array of FileTagRow with source="graph-role" and confidence=0.7.
 */
export function computeGraphRoleTags(query: KgQuery): FileTagRow[] {
  const degrees = query.getAllFileDegrees();
  const result: FileTagRow[] = [];

  if (degrees.size === 0) return result;

  // Compute top-10% hub threshold from all in-degrees
  const inDegrees = Array.from(degrees.values()).map((d) => d.in_degree);
  inDegrees.sort((a, b) => b - a);
  const top10Index = Math.floor(inDegrees.length * 0.1);
  const top10Threshold = top10Index < inDegrees.length ? (inDegrees[top10Index] ?? 0) : Infinity;

  for (const [fileId, { in_degree, out_degree }] of degrees) {
    // Hub: absolute threshold OR top 10% by in-degree
    if (in_degree >= HUB_IN_DEGREE_THRESHOLD || in_degree >= top10Threshold) {
      result.push({
        confidence: 0.7,
        file_id: fileId,
        source: "graph-role",
        tag: "hub",
      });
    }

    // Entry point: zero in-degree (nothing imports this file)
    if (in_degree === 0) {
      result.push({
        confidence: 0.7,
        file_id: fileId,
        source: "graph-role",
        tag: "entry-point",
      });
    }

    // Leaf: zero out-degree (this file imports nothing in the graph)
    if (out_degree === 0) {
      result.push({
        confidence: 0.7,
        file_id: fileId,
        source: "graph-role",
        tag: "leaf",
      });
    }
  }

  return result;
}

/** Group files by their community_id, ignoring files with no community. */
function groupByCommunity(
  allFiles: ReturnType<KgQuery["getAllFilesWithStats"]>,
): Map<number, Array<{ file_id: number }>> {
  const groups = new Map<number, Array<{ file_id: number }>>();
  for (const file of allFiles) {
    if (file.file_id === undefined) continue;
    // community_id is in the files table but not in getAllFilesWithStats return type
    const communityId = (file as unknown as { community_id?: number | null }).community_id;
    if (communityId === null || communityId === undefined) continue;

    let group = groups.get(communityId);
    if (!group) {
      group = [];
      groups.set(communityId, group);
    }
    group.push({ file_id: file.file_id });
  }
  return groups;
}

/** Collect existing tags per member in a community. */
function collectMemberTags(
  members: Array<{ file_id: number }>,
  store: KgStore,
): Map<number, Set<string>> {
  const memberTags = new Map<number, Set<string>>();
  for (const member of members) {
    const tags = store.getFileTagsByFileId(member.file_id);
    memberTags.set(member.file_id, new Set(tags.map((t) => t.tag)));
  }
  return memberTags;
}

/** Count how many community members have each tag. */
function countTagFrequencies(memberTags: Map<number, Set<string>>): Map<string, number> {
  const tagCounts = new Map<string, number>();
  for (const tagSet of memberTags.values()) {
    for (const tag of tagSet) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return tagCounts;
}

/** Emit propagated tag rows for one community. */
function propagateCommunityTags(
  members: Array<{ file_id: number }>,
  memberTags: Map<number, Set<string>>,
  tagCounts: Map<string, number>,
): FileTagRow[] {
  const rows: FileTagRow[] = [];
  for (const [tag, count] of tagCounts) {
    const fraction = count / members.length;
    if (fraction <= COMMUNITY_TAG_THRESHOLD) continue;

    for (const member of members) {
      if (memberTags.get(member.file_id)?.has(tag)) continue;
      rows.push({
        confidence: 0.6,
        file_id: member.file_id,
        source: "community",
        tag,
      });
    }
  }
  return rows;
}

/**
 * Compute community-derived tags by propagating majority tags within communities.
 *
 * For each community (group of files sharing community_id):
 * 1. Collect all tags currently on community members.
 * 2. For each tag present on > COMMUNITY_TAG_THRESHOLD of members, propagate it
 *    to members that don't already have that tag.
 *
 * @param store - KgStore instance for reading file tags and upserts.
 * @param query - KgQuery instance for reading files with community assignments.
 * @returns Array of FileTagRow with source="community" and confidence=0.6.
 *   Only includes tags for files that don't already have the tag.
 */
export function computeCommunityDerivedTags(store: KgStore, query: KgQuery): FileTagRow[] {
  const allFiles = query.getAllFilesWithStats();
  const result: FileTagRow[] = [];

  const communityGroups = groupByCommunity(allFiles);

  for (const [, members] of communityGroups) {
    if (members.length === 0) continue;
    const memberTags = collectMemberTags(members, store);
    const tagCounts = countTagFrequencies(memberTags);
    const rows = propagateCommunityTags(members, memberTags, tagCounts);
    for (const row of rows) {
      result.push(row);
    }
  }

  return result;
}

/**
 * Orchestrate all 4 tag signal sources and persist results.
 *
 * Clears all existing file tags (full recompute — consistent with Louvain
 * recompute), then calls each source function in sequence and bulk-upserts
 * the results into file_tags.
 *
 * @param store - KgStore instance for writes (clear + bulk upsert).
 * @param query - KgQuery instance passed through to all signal sources.
 * @returns Summary with total tag count and per-source breakdown.
 */
export function propagateAllTags(store: KgStore, query: KgQuery): TagPropagationResult {
  // Full recompute: clear all existing tags first
  const allFiles = query.getAllFilesWithStats();
  store.transaction(() => {
    for (const file of allFiles) {
      if (file.file_id !== undefined) {
        store.deleteFileTagsByFile(file.file_id);
      }
    }
  });

  const bySource: Record<string, number> = {
    community: 0,
    directory: 0,
    "graph-role": 0,
    import: 0,
  };

  // Signal 1: directory-derived tags
  const directoryTags = computeDirectoryTags(query);
  store.bulkUpsertFileTags(directoryTags);
  bySource.directory = directoryTags.length;

  // Signal 2: import-derived tags
  const importTags = computeImportDerivedTags(store, query);
  store.bulkUpsertFileTags(importTags);
  bySource.import = importTags.length;

  // Signal 3: graph-role-derived tags
  const graphRoleTags = computeGraphRoleTags(query);
  store.bulkUpsertFileTags(graphRoleTags);
  bySource["graph-role"] = graphRoleTags.length;

  // Signal 4: community-derived tags (depends on directory/import tags already written)
  const communityTags = computeCommunityDerivedTags(store, query);
  store.bulkUpsertFileTags(communityTags);
  bySource.community = communityTags.length;

  const totalTags =
    directoryTags.length + importTags.length + graphRoleTags.length + communityTags.length;

  return { bySource, totalTags };
}
