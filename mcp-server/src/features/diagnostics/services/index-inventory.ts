/**
 * Index Inventory — marker-block hybrid generator for sibling artifact indexes.
 *
 * Exports:
 * - Sentinel constants (Decision retrofit-indexes-01)
 * - Pure functions: toDescriptors, renderInventoryBlock, rewriteManagedBlock,
 *   extractManagedBlock, diffIndex
 * - Async I/O function at the bottom (clearly separated): checkIndexDrift
 *
 * Canon principles:
 * - pure-io-service-split: all pure functions above; only checkIndexDrift touches fs
 * - simplicity-first: no strategy flags, no class hierarchy
 * - errors-are-values: rewriteManagedBlock returns discriminated result; diffIndex never throws
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ---- Sentinel constants (Decision retrofit-indexes-01) ----

export const INVENTORY_START = (cls: string): string =>
  `<!-- canon:inventory:start class=${cls} -->`;
export const INVENTORY_END = "<!-- canon:inventory:end -->";

// ---- Types ----

export type ArtifactClass = "rules" | "principles" | "agents" | "templates" | "references";

export type ArtifactDescriptor = { name: string; summary: string };

export type IndexDriftFinding = {
  class: ArtifactClass;
  code: "MISSING_MARKERS" | "INVENTORY_MISMATCH";
  message: string;
};

// ---- Per-class discovery directories (relative to projectDir) ----

export const CLASS_DIRS: Record<ArtifactClass, string[]> = {
  agents: ["agents"],
  principles: ["principles/rules", "principles/strong-opinions", "principles/conventions"],
  references: ["references"],
  rules: ["rules"],
  templates: ["templates"],
};

// ---- Pure functions ----

/**
 * Extract a one-line summary from a frontmatter string.
 * Returns `title:` value if present, else `description:` value, else "".
 */
function extractSummaryFromFrontmatter(frontmatter: string): string {
  const titleMatch = /^title:\s*(.+)$/m.exec(frontmatter);
  if (titleMatch) return titleMatch[1].trim();
  const descMatch = /^description:\s*(.+)$/m.exec(frontmatter);
  if (descMatch) return descMatch[1].trim();
  return "";
}

/**
 * Given a list of { filename, frontmatter } objects, return sorted ArtifactDescriptors.
 * Excludes README.md. summary = frontmatter `title:` ?? `description:` ?? "".
 * Pure function — no I/O.
 */
export function toDescriptors(
  files: Array<{ filename: string; frontmatter: string }>,
): ArtifactDescriptor[] {
  return files
    .filter((f) => f.filename !== "README.md")
    .map((f) => ({
      name: f.filename,
      summary: extractSummaryFromFrontmatter(f.frontmatter),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render a deterministic markdown table body for the inventory block.
 * Returns ONLY the table content (between sentinels), sorted by name.
 * No timestamps. Same input → byte-identical output.
 * Pure function — no I/O.
 */
export function renderInventoryBlock(descriptors: ArtifactDescriptor[]): string {
  const sorted = [...descriptors].sort((a, b) => a.name.localeCompare(b.name));
  const header = "| artifact | summary |";
  const divider = "|---|---|";
  const rows = sorted.map((d) => `| ${d.name} | ${d.summary} |`);
  return [header, divider, ...rows].join("\n");
}

/**
 * Splice the rendered body between the sentinel pair, preserving every
 * byte outside the pair. If markers absent, returns { ok: false, reason: "missing-markers" }.
 * If present, returns { ok: true, content } with only the inner lines replaced.
 * Pure function — no I/O.
 */
export function rewriteManagedBlock(
  fileContent: string,
  cls: ArtifactClass,
  blockBody: string,
): { ok: true; content: string } | { ok: false; reason: "missing-markers" } {
  const startSentinel = INVENTORY_START(cls);
  const endSentinel = INVENTORY_END;

  const startIdx = fileContent.indexOf(startSentinel);
  if (startIdx === -1) return { ok: false, reason: "missing-markers" };

  const endIdx = fileContent.indexOf(endSentinel, startIdx + startSentinel.length);
  if (endIdx === -1) return { ok: false, reason: "missing-markers" };

  const prefix = fileContent.slice(0, startIdx + startSentinel.length);
  const suffix = fileContent.slice(endIdx);

  const content = `${prefix}\n${blockBody}\n${suffix}`;
  return { content, ok: true };
}

/**
 * Extract the current block body between sentinels, or null if absent.
 * Returns the text between the start and end sentinels (trimmed).
 * Pure function — no I/O.
 */
export function extractManagedBlock(fileContent: string, cls: ArtifactClass): string | null {
  const startSentinel = INVENTORY_START(cls);
  const endSentinel = INVENTORY_END;

  const startIdx = fileContent.indexOf(startSentinel);
  if (startIdx === -1) return null;

  const bodyStart = startIdx + startSentinel.length;
  const endIdx = fileContent.indexOf(endSentinel, bodyStart);
  if (endIdx === -1) return null;

  return fileContent.slice(bodyStart, endIdx).trim();
}

/**
 * Compare expected vs actual block; return findings (never throws).
 * - No sentinels → MISSING_MARKERS
 * - Body mismatch → INVENTORY_MISMATCH
 * - Identical → []
 * Pure function — no I/O.
 */
export function diffIndex(
  cls: ArtifactClass,
  expectedBody: string,
  fileContent: string,
): IndexDriftFinding[] {
  try {
    const actualBody = extractManagedBlock(fileContent, cls);
    if (actualBody === null) {
      return [
        {
          class: cls,
          code: "MISSING_MARKERS",
          message: `Index for class '${cls}' is missing sentinel markers <!-- canon:inventory:start class=${cls} --> / <!-- canon:inventory:end -->`,
        },
      ];
    }

    if (actualBody.trim() !== expectedBody.trim()) {
      return [
        {
          class: cls,
          code: "INVENTORY_MISMATCH",
          message: `Index for class '${cls}' inventory block does not match the current artifact set on disk`,
        },
      ];
    }

    return [];
  } catch {
    // Never throw — return a finding instead
    return [
      {
        class: cls,
        code: "INVENTORY_MISMATCH",
        message: `Index for class '${cls}' could not be compared (unexpected error)`,
      },
    ];
  }
}

// ---- I/O (clearly separated from pure functions above) ----

/**
 * Read frontmatter from a markdown file.
 * Returns the raw frontmatter string between --- delimiters, or "" if absent/unreadable.
 */
async function readFrontmatter(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

/**
 * Discover all artifact files for a class by reading the CLASS_DIRS directories.
 * Returns ArtifactDescriptors sorted by name, excluding README.md.
 */
async function discoverArtifacts(
  cls: ArtifactClass,
  projectDir: string,
): Promise<ArtifactDescriptor[]> {
  const dirs = CLASS_DIRS[cls];
  const allFiles: Array<{ filename: string; frontmatter: string }> = [];

  for (const dir of dirs) {
    const fullDir = join(projectDir, dir);
    let entries: string[];
    try {
      entries = await readdir(fullDir);
    } catch {
      // Directory missing — skip silently
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

  return toDescriptors(allFiles);
}

/** Path to the index file for a given class (relative to projectDir). */
function indexFilePath(cls: ArtifactClass): string {
  return join(cls, ".claude", "CLAUDE.md");
}

/**
 * Check drift for all 5 artifact classes.
 *
 * For each class: discover artifacts on disk, render the expected block, read
 * the index file, extract the actual block, compare via diffIndex.
 *
 * This is the ONE place in this module that touches node:fs at the call site.
 * All pure computation is delegated to toDescriptors, renderInventoryBlock, diffIndex.
 */
export async function checkIndexDrift(projectDir: string): Promise<IndexDriftFinding[]> {
  const classes: ArtifactClass[] = ["rules", "principles", "agents", "templates", "references"];
  const allFindings: IndexDriftFinding[] = [];

  await Promise.all(
    classes.map(async (cls) => {
      try {
        const descriptors = await discoverArtifacts(cls, projectDir);
        const expectedBody = renderInventoryBlock(descriptors);

        const indexPath = join(projectDir, indexFilePath(cls));
        let fileContent: string;
        try {
          fileContent = await readFile(indexPath, "utf8");
        } catch {
          // Index file missing — treat as MISSING_MARKERS
          allFindings.push({
            class: cls,
            code: "MISSING_MARKERS",
            message: `Index file for class '${cls}' not found at ${indexPath}`,
          });
          return;
        }

        const findings = diffIndex(cls, expectedBody, fileContent);
        allFindings.push(...findings);
      } catch {
        // Fail-open: log unexpected errors as findings rather than throwing
        allFindings.push({
          class: cls,
          code: "INVENTORY_MISMATCH",
          message: `Unexpected error checking index drift for class '${cls}'`,
        });
      }
    }),
  );

  return allFindings;
}
