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
 * - observable-best-effort: ENOENT on a class dir is silently skipped; any other readdir
 *   error surfaces as a DISCOVERY_ERROR finding so checkIndexDrift never reports CLEAN
 *   against a truncated artifact set
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// ---- Sentinel constants (Decision retrofit-indexes-01) ----

export const INVENTORY_START = (cls: string): string =>
  `<!-- canon:inventory:start class=${cls} -->`;
export const INVENTORY_END = "<!-- canon:inventory:end -->";

// ---- Types ----

export type ArtifactClass = "rules" | "principles" | "agents" | "templates" | "references";

export type ArtifactDescriptor = { name: string; summary: string };

export type IndexDriftFinding = {
  class: ArtifactClass;
  code: "MISSING_MARKERS" | "INVENTORY_MISMATCH" | "DISCOVERY_ERROR" | "UNREADABLE_ARTIFACT";
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
 *
 * Parses the already-sliced YAML block directly with the `yaml` lib so block
 * scalars (>-, |, etc.) are folded/chomped correctly rather than yielding the
 * literal indicator string. Pure function — no I/O.
 */
function extractSummaryFromFrontmatter(frontmatter: string): string {
  if (!frontmatter) return "";
  const data = (parseYaml(frontmatter) ?? {}) as Record<string, unknown>;

  const title = data.title;
  if (typeof title === "string" && title.trim()) return title.trim();

  const desc = data.description;
  if (typeof desc === "string" && desc.trim()) {
    // Collapse block-scalar newlines/indentation into a single line
    return desc.replace(/\s+/g, " ").trim();
  }
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

type FrontmatterResult = { ok: true; frontmatter: string } | { ok: false; error: string };

/**
 * Read frontmatter from a markdown file.
 *
 * Returns { ok: true, frontmatter } on success (frontmatter is "" when no YAML block is
 * found — a valid file with no frontmatter). Returns { ok: false, error } when the file
 * cannot be read (permission error, broken symlink, transient I/O failure, etc.).
 *
 * This distinction matters: a read ERROR must not be treated as empty frontmatter, because
 * that would silently mask real drift by producing CLEAN on incomplete data.
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

type ScanOneDirResult = {
  files: Array<{ filename: string; frontmatter: string }>;
  discoveryError?: string;
  unreadableFiles: Array<{ filePath: string; message: string }>;
};

/**
 * Scan one directory for .md artifact files.
 *
 * observable-best-effort: ENOENT/ENOTDIR → silent skip (legitimately absent).
 * Any other readdir error → discoveryError (dir exists but unreadable).
 * Individual file read errors → unreadableFiles (must surface, not silently empty).
 */
async function scanOneDir(fullDir: string): Promise<ScanOneDirResult> {
  let entries: string[];
  try {
    entries = await readdir(fullDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { files: [], unreadableFiles: [] };
    }
    return {
      discoveryError: err instanceof Error ? err.message : String(err),
      files: [],
      unreadableFiles: [],
    };
  }

  const mdFilenames = entries.filter(
    (e) => e.endsWith(".md") && e !== "README.md" && !e.startsWith("."),
  );

  const results = await Promise.all(
    mdFilenames.map(async (filename) => {
      const fullPath = join(fullDir, filename);
      const result = await readFrontmatter(fullPath);
      return { filename, fullPath, result };
    }),
  );

  const files: Array<{ filename: string; frontmatter: string }> = [];
  const unreadableFiles: Array<{ filePath: string; message: string }> = [];
  for (const { filename, fullPath, result } of results) {
    if (!result.ok) {
      unreadableFiles.push({ filePath: fullPath, message: result.error });
    } else {
      files.push({ filename, frontmatter: result.frontmatter });
    }
  }

  return { files, unreadableFiles };
}

/**
 * Discover all artifact files for a class by reading the CLASS_DIRS directories.
 *
 * Returns:
 * - `descriptors`: ArtifactDescriptors sorted by name, excluding README.md
 * - `discoveryErrors`: one entry per directory that failed with an unexpected
 *   error (NOT ENOENT/ENOTDIR — those are silently skipped as legitimately
 *   absent dirs). Non-empty discoveryErrors means the inventory is truncated;
 *   callers must surface this rather than reporting CLEAN.
 * - `unreadableFiles`: one entry per artifact file that could not be read
 *   (permission error, broken symlink, transient I/O failure). Non-empty means
 *   the inventory is incomplete; callers must surface this rather than reporting
 *   CLEAN against incomplete data.
 */
async function discoverArtifacts(
  cls: ArtifactClass,
  projectDir: string,
): Promise<{
  descriptors: ArtifactDescriptor[];
  discoveryErrors: Array<{ dir: string; message: string }>;
  unreadableFiles: Array<{ filePath: string; message: string }>;
}> {
  const allFiles: Array<{ filename: string; frontmatter: string }> = [];
  const discoveryErrors: Array<{ dir: string; message: string }> = [];
  const unreadableFiles: Array<{ filePath: string; message: string }> = [];

  const scanResults = await Promise.all(
    CLASS_DIRS[cls].map(async (dir) => {
      const fullDir = join(projectDir, dir);
      const result = await scanOneDir(fullDir);
      return { fullDir, result };
    }),
  );
  for (const { fullDir, result } of scanResults) {
    if (result.discoveryError) {
      discoveryErrors.push({ dir: fullDir, message: result.discoveryError });
    } else {
      allFiles.push(...result.files);
      unreadableFiles.push(...result.unreadableFiles);
    }
  }

  return { descriptors: toDescriptors(allFiles), discoveryErrors, unreadableFiles };
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
        const { descriptors, discoveryErrors, unreadableFiles } = await discoverArtifacts(
          cls,
          projectDir,
        );

        // Surface any unexpected directory-read errors — do NOT silently continue
        // past them, as doing so would report CLEAN against a truncated inventory
        for (const de of discoveryErrors) {
          allFindings.push({
            class: cls,
            code: "DISCOVERY_ERROR",
            message: `Discovery degraded for class '${cls}': could not read directory '${de.dir}' — ${de.message}`,
          });
        }

        // Surface any unreadable individual artifact files — a read error must NOT
        // be treated as empty frontmatter; that would mask real drift by reporting
        // CLEAN against an incomplete set of descriptors
        for (const uf of unreadableFiles) {
          allFindings.push({
            class: cls,
            code: "UNREADABLE_ARTIFACT",
            message: `Could not read artifact file during index drift check: ${uf.message}`,
          });
        }

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
