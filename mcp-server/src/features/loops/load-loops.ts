/**
 * Loop registry loader — reads all loops/*.md files and parses them.
 *
 * Modelled directly on mcp-server/src/shared/matcher.ts's loadMdFilesFromDir:
 *   readdir(dir) → filter .md → parse each → collect valid/invalid.
 *
 * Design decisions honoured:
 * - loops-phase-a-02: the loops/ directory IS the registry; loader is a thin
 *   adaptation of the existing pattern, not a new parser.
 * - errors-as-values: returns { valid, invalid } value; never throws for expected
 *   conditions (ENOENT, parse failures are expected conditions).
 * - observable-best-effort: invalid definitions land in invalid[] with filename;
 *   never silently dropped.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import matter from "gray-matter";
import { type LoopDefinition, parseLoopDefinition } from "./loop-schema.ts";

export type LoadLoopsResult = {
  /** Successfully parsed and validated loop definitions. */
  valid: LoopDefinition[];
  /** Failed definitions — surfaced with filename and error message. */
  invalid: { file: string; error: string }[];
  /**
   * Bodies (the action prompt markdown) keyed by loop id.
   * Available when valid is non-empty — used by get_loop_definition.
   */
  validBodies?: Record<string, string>;
};

type LoopFileResult =
  | { ok: true; definition: LoopDefinition; body: string }
  | { ok: false; file: string; error: string }
  | { skip: true };

/**
 * Parse a single loop .md file. Returns ok:true with definition+body,
 * or ok:false with the filename and error message.
 * Never throws — all error conditions are returned as values.
 */
async function parseLoopFile(filePath: string): Promise<LoopFileResult> {
  const idFromFilename = basename(filePath, ".md");

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    return {
      error: `failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      file: filePath,
      ok: false,
    };
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(content);
  } catch (err) {
    return {
      error: `failed to parse frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      file: filePath,
      ok: false,
    };
  }

  // Skip documentation files (CLAUDE.md, README.md) that lack an `id` field.
  // Only files with a non-empty string `id` in frontmatter are treated as loop definitions.
  const rawId = (parsed.data as Record<string, unknown>).id;
  if (typeof rawId !== "string" || rawId.trim() === "") {
    return { skip: true };
  }

  const result = parseLoopDefinition(parsed.data, { idFromFilename });
  if (!result.ok) {
    return { error: result.error, file: filePath, ok: false };
  }

  return { body: parsed.content.trim(), definition: result.definition, ok: true };
}

/**
 * Load all loop definitions from a directory.
 *
 * - ENOENT → returns { valid: [], invalid: [] } (mirrors matcher ENOENT swallow)
 * - Other read errors → logs a warning and returns what loaded (fail-open read)
 * - Only .md files are processed; non-.md files are ignored
 * - Invalid definitions appear in invalid[] with filename and error; never dropped
 */
export async function loadLoopsFromDir(dir: string): Promise<LoadLoopsResult> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { invalid: [], valid: [] };
    }
    console.warn(
      "[canon] loops: failed to read directory",
      dir,
      ":",
      err instanceof Error ? err.message : err,
    );
    return { invalid: [], valid: [] };
  }

  const mdFiles = files.filter((f) => f.endsWith(".md"));
  const results = await Promise.all(mdFiles.map((filename) => parseLoopFile(join(dir, filename))));

  const valid: LoopDefinition[] = [];
  const invalid: { file: string; error: string }[] = [];
  const validBodies: Record<string, string> = {};

  for (const r of results) {
    if ("skip" in r) {
      // Documentation file without an `id` field — not a loop definition, silently ignore.
      continue;
    }
    if (r.ok) {
      valid.push(r.definition);
      validBodies[r.definition.id] = r.body;
    } else {
      invalid.push({ error: r.error, file: r.file });
    }
  }

  return { invalid, valid, validBodies };
}
