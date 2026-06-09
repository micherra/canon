/**
 * sync_indexes MCP Tool Handler
 *
 * Reads each artifact class from disk, regenerates the inventory block between
 * the sentinel markers, and atomically writes the updated index file.
 *
 * Canon principles:
 * - pure-io-service-split: all pure computation in services/index-inventory.ts; I/O here
 * - errors-are-values: returns ToolResult; never throws for expected conditions
 * - simplicity-first: thin handler, no branching strategy
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import {
  type ArtifactClass,
  CLASS_DIRS,
  renderInventoryBlock,
  rewriteManagedBlock,
  toDescriptors,
} from "../services/index-inventory.ts";

// ---- Types ----

export type SyncIndexesInput = { class?: ArtifactClass };

export type SyncIndexesOutput = {
  synced: ArtifactClass[];
  skipped: Array<{ class: ArtifactClass; reason: string }>;
};

// ---- Helpers ----

/** Read frontmatter from a markdown file; returns "" on any error. */
async function readFrontmatter(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

/** Path to the index file for a given artifact class. */
function indexFilePath(cls: ArtifactClass, projectDir: string): string {
  return join(projectDir, cls, ".claude", "CLAUDE.md");
}

/**
 * Process one artifact class: discover artifacts, render block, read index,
 * rewrite markers if present, write atomically.
 * Returns { synced: true } or { synced: false, reason }.
 */
async function processClass(
  cls: ArtifactClass,
  projectDir: string,
): Promise<{ synced: true } | { synced: false; reason: string }> {
  const dirs = CLASS_DIRS[cls];
  const allFiles: Array<{ filename: string; frontmatter: string }> = [];

  for (const dir of dirs) {
    const fullDir = join(projectDir, dir);
    let entries: string[];
    try {
      entries = await readdir(fullDir);
    } catch {
      continue;
    }
    const mdFiles = entries.filter(
      (e) => e.endsWith(".md") && e !== "README.md" && !e.startsWith("."),
    );
    for (const filename of mdFiles) {
      const frontmatter = await readFrontmatter(join(fullDir, filename));
      allFiles.push({ filename, frontmatter });
    }
  }

  const descriptors = toDescriptors(allFiles);
  const blockBody = renderInventoryBlock(descriptors);

  const idxPath = indexFilePath(cls, projectDir);
  let currentContent: string;
  try {
    currentContent = await readFile(idxPath, "utf8");
  } catch {
    return { reason: "index file not found or unreadable", synced: false };
  }

  const rewriteResult = rewriteManagedBlock(currentContent, cls, blockBody);
  if (!rewriteResult.ok) {
    return { reason: rewriteResult.reason, synced: false };
  }

  await atomicWriteFile(idxPath, rewriteResult.content);
  return { synced: true };
}

// ---- Main handler ----

const ALL_CLASSES: ArtifactClass[] = ["rules", "principles", "agents", "templates", "references"];

/**
 * Regenerate the sentinel-delimited inventory block of one or all sibling
 * artifact-class indexes, preserving prose outside the markers.
 */
export async function syncIndexes(
  input: SyncIndexesInput,
  projectDir: string,
): Promise<ToolResult<SyncIndexesOutput>> {
  const targets = input.class ? [input.class] : ALL_CLASSES;
  const synced: ArtifactClass[] = [];
  const skipped: Array<{ class: ArtifactClass; reason: string }> = [];

  try {
    await Promise.all(
      targets.map(async (cls) => {
        const result = await processClass(cls, projectDir);
        if (result.synced) {
          synced.push(cls);
        } else {
          skipped.push({ class: cls, reason: result.reason });
        }
      }),
    );
  } catch (err) {
    return toolError(
      "UNEXPECTED",
      `sync_indexes: unexpected error — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return toolOk({ skipped, synced });
}
