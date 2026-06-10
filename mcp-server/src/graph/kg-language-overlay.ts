/**
 * Project-local KG language overlay loader.
 *
 * Loads supplemental LanguageConfig entries from `.canon/kg-languages/*.json`
 * and validates that each has a paired grammar wasm in `.canon/grammars/`.
 * Invalid or missing entries are SKIPPED with a console.warn — never thrown.
 * The built-in KG languages are never affected by a failing overlay entry.
 *
 * This module is fail-open by design (Decision lsp-recommender-06): a bad
 * project-local overlay must never break the built-in KG walker.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageConfig, NodeKindMap } from "./kg-language-configs.ts";

// ─── NodeKindMap validation ────────────────────────────────────────────────

const NODE_KIND_ROLES: ReadonlyArray<keyof NodeKindMap> = [
  "functionDef",
  "classDef",
  "methodDef",
  "importStatement",
  "callExpression",
  "variableDecl",
  "exportStatement",
  "classBody",
];

/**
 * Validate that a raw JSON value has the shape of a NodeKindMap:
 * an object with all 8 required roles, each mapping to a string[].
 * Empty arrays are allowed (some languages have no exports, etc.).
 */
function validateNodeKindMap(raw: unknown, id: string): NodeKindMap | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn(`kg-language-overlay: [${id}] nodeKinds must be an object — skipping`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const result: Partial<NodeKindMap> = {};
  for (const role of NODE_KIND_ROLES) {
    const val = obj[role];
    if (!Array.isArray(val)) {
      console.warn(
        `kg-language-overlay: [${id}] nodeKinds.${role} is missing or not an array — skipping`,
      );
      return null;
    }
    if (!val.every((item) => typeof item === "string")) {
      console.warn(
        `kg-language-overlay: [${id}] nodeKinds.${role} contains non-string values — skipping`,
      );
      return null;
    }
    result[role] = val as string[];
  }
  return result as NodeKindMap;
}

// ─── Overlay JSON schema ───────────────────────────────────────────────────

type RawOverlayEntry = {
  id: string;
  extensions: string[];
  grammarFile: string;
  nodeKinds: NodeKindMap;
};

/**
 * Validate the top-level shape of a parsed overlay JSON object.
 * Returns the coerced entry or null on any violation.
 * `hooks` are intentionally NOT expected in v1 (Decision lsp-recommender-07).
 */
function validateOverlayEntry(
  raw: unknown,
  filePath: string,
  builtinIds: ReadonlySet<string>,
): RawOverlayEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn(`kg-language-overlay: ${filePath} — root must be a JSON object — skipping`);
    return null;
  }
  const obj = raw as Record<string, unknown>;

  // id
  if (typeof obj["id"] !== "string" || obj["id"].trim() === "") {
    console.warn(`kg-language-overlay: ${filePath} — missing or empty 'id' field — skipping`);
    return null;
  }
  const id = obj["id"].trim();

  // Built-in collision: built-in wins, overlay entry dropped
  if (builtinIds.has(id)) {
    console.warn(
      `kg-language-overlay: [${id}] collides with a built-in language id — built-in wins, skipping overlay entry`,
    );
    return null;
  }

  // extensions
  if (!Array.isArray(obj["extensions"])) {
    console.warn(`kg-language-overlay: [${id}] 'extensions' must be an array — skipping`);
    return null;
  }
  if (!obj["extensions"].every((e) => typeof e === "string")) {
    console.warn(`kg-language-overlay: [${id}] 'extensions' must be string[] — skipping`);
    return null;
  }
  const extensions = obj["extensions"] as string[];

  // grammarFile
  if (typeof obj["grammarFile"] !== "string" || obj["grammarFile"].trim() === "") {
    console.warn(`kg-language-overlay: [${id}] missing or empty 'grammarFile' field — skipping`);
    return null;
  }
  const grammarFile = obj["grammarFile"].trim();

  // nodeKinds
  const nodeKinds = validateNodeKindMap(obj["nodeKinds"], id);
  if (!nodeKinds) return null;

  return { extensions, grammarFile, id, nodeKinds };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Resolve the absolute path to an overlay grammar wasm file.
 *
 * @param projectDir - The project root directory (where `.canon/` lives)
 * @param grammarFile - The wasm file name (e.g. "tree-sitter-go.wasm")
 */
export function overlayGrammarPath(projectDir: string, grammarFile: string): string {
  return join(projectDir, ".canon", "grammars", grammarFile);
}

/**
 * Load and validate all project-local overlay LanguageConfig entries.
 *
 * Reads `${projectDir}/.canon/kg-languages/*.json`. For each file:
 * - Parses JSON
 * - Validates the LanguageConfig shape (id, extensions, grammarFile, nodeKinds with all 8 roles)
 * - Checks that the paired wasm exists at `${projectDir}/.canon/grammars/${grammarFile}`
 * - Checks that `id` does NOT collide with a built-in id
 *
 * Entries that fail ANY check are skipped with a console.warn. The function
 * never throws — an empty or absent directory returns [].
 *
 * @param projectDir - The project root directory (where `.canon/` lives)
 * @param builtinIds - Set of built-in language ids that overlay cannot shadow
 */
export function loadOverlayConfigs(
  projectDir: string,
  builtinIds: ReadonlySet<string>,
): LanguageConfig[] {
  const overlayDir = join(projectDir, ".canon", "kg-languages");

  // If the directory doesn't exist, return [] (not an error)
  if (!existsSync(overlayDir)) {
    return [];
  }

  let files: string[];
  try {
    files = readdirSync(overlayDir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`kg-language-overlay: could not read overlay dir '${overlayDir}': ${message}`);
    return [];
  }

  const results: LanguageConfig[] = [];

  for (const file of files) {
    const filePath = join(overlayDir, file);

    // Parse JSON
    let raw: unknown;
    try {
      const text = readFileSync(filePath, "utf-8");
      raw = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`kg-language-overlay: failed to parse '${filePath}': ${message} — skipping`);
      continue;
    }

    // Validate shape + collision check
    const entry = validateOverlayEntry(raw, filePath, builtinIds);
    if (!entry) continue;

    // Paired wasm existence check
    const wasmPath = overlayGrammarPath(projectDir, entry.grammarFile);
    if (!existsSync(wasmPath)) {
      console.warn(
        `kg-language-overlay: [${entry.id}] paired grammar wasm not found at '${wasmPath}' — skipping`,
      );
      continue;
    }

    // Entry passes all checks — activate it
    results.push({
      extensions: entry.extensions,
      grammarFile: entry.grammarFile,
      id: entry.id,
      nodeKinds: entry.nodeKinds,
      // hooks: intentionally omitted in v1 (Decision lsp-recommender-07)
    });
  }

  return results;
}
