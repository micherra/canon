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

type FrontmatterResult = { ok: true; frontmatter: string } | { ok: false; error: string };

/**
 * Read frontmatter from a markdown file.
 *
 * Returns { ok: true, frontmatter } on success (frontmatter is "" when no YAML block is
 * found — a valid file with no frontmatter). Returns { ok: false, error } when the file
 * cannot be read (permission error, broken symlink, transient I/O failure, etc.).
 *
 * This distinction matters: a read ERROR must not be treated as empty frontmatter, because
 * that would silently erase existing summaries from the managed inventory block.
 */
async function readFrontmatter(filePath: string): Promise<FrontmatterResult> {
  try {
    const content = await readFile(filePath, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    return { frontmatter: match ? match[1] : "", ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `unreadable artifact '${filePath}': ${msg}`, ok: false };
  }
}

/** Path to the index file for a given artifact class. */
function indexFilePath(cls: ArtifactClass, projectDir: string): string {
  return join(projectDir, cls, ".claude", "CLAUDE.md");
}

type ScanResult =
  | { ok: true; files: Array<{ filename: string; frontmatter: string }> }
  | { ok: false; reason: string };

/**
 * Scan one artifact directory for .md files.
 *
 * observable-best-effort: ENOENT/ENOTDIR → silent skip (legitimately absent).
 * Any other error → returns { ok: false, reason } so the caller can surface it.
 */
async function scanDir(
  fullDir: string,
  files: Array<{ filename: string; frontmatter: string }>,
): Promise<{ skipped: boolean; error?: string }> {
  let entries: string[];
  try {
    entries = await readdir(fullDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { skipped: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `discovery error for directory '${fullDir}': ${msg}`, skipped: false };
  }
  const mdFiles = entries.filter(
    (e) => e.endsWith(".md") && e !== "README.md" && !e.startsWith("."),
  );
  for (const filename of mdFiles) {
    const result = await readFrontmatter(join(fullDir, filename));
    if (!result.ok) {
      return { error: result.error, skipped: false };
    }
    files.push({ filename, frontmatter: result.frontmatter });
  }
  return { skipped: false };
}

/**
 * Collect all artifact files for a class across its directories.
 * Returns { ok: true, files } or { ok: false, reason } on unexpected I/O error.
 */
async function collectFiles(cls: ArtifactClass, projectDir: string): Promise<ScanResult> {
  const files: Array<{ filename: string; frontmatter: string }> = [];
  for (const dir of CLASS_DIRS[cls]) {
    const result = await scanDir(join(projectDir, dir), files);
    if (result.error) {
      return { ok: false, reason: result.error };
    }
  }
  return { files, ok: true };
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
  const collected = await collectFiles(cls, projectDir);
  if (!collected.ok) {
    return { reason: collected.reason, synced: false };
  }

  const descriptors = toDescriptors(collected.files);
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

export const ALL_CLASSES = [
  "rules",
  "principles",
  "agents",
  "templates",
  "references",
  "primers",
] as const;

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
