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
import { parseLoopDefinition, type LoopDefinition } from "./loop-schema.ts";

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
  const valid: LoopDefinition[] = [];
  const invalid: { file: string; error: string }[] = [];
  const validBodies: Record<string, string> = {};

  await Promise.all(
    mdFiles.map(async (filename) => {
      const filePath = join(dir, filename);
      const idFromFilename = basename(filename, ".md");

      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch (err) {
        invalid.push({
          error: `failed to read file: ${err instanceof Error ? err.message : String(err)}`,
          file: filePath,
        });
        return;
      }

      let parsed: ReturnType<typeof matter>;
      try {
        parsed = matter(content);
      } catch (err) {
        invalid.push({
          error: `failed to parse frontmatter: ${err instanceof Error ? err.message : String(err)}`,
          file: filePath,
        });
        return;
      }

      const result = parseLoopDefinition(parsed.data, { idFromFilename });
      if (result.ok) {
        valid.push(result.definition);
        validBodies[result.definition.id] = parsed.content.trim();
      } else {
        invalid.push({ error: result.error, file: filePath });
      }
    }),
  );

  return { invalid, valid, validBodies };
}
