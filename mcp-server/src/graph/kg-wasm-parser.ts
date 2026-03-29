/**
 * WASM parser infrastructure for web-tree-sitter.
 *
 * This module hides all WASM complexity (async init, grammar path resolution,
 * parser caching) behind three simple exports.
 *
 * Grammar WASM sources:
 *   tree-sitter-typescript.wasm — copied from node_modules/tree-sitter-typescript/
 *   tree-sitter-tsx.wasm        — copied from node_modules/tree-sitter-typescript/
 *   tree-sitter-python.wasm     — copied from node_modules/tree-sitter-python/
 *   tree-sitter-bash.wasm       — copied from node_modules/tree-sitter-bash/
 *   tree-sitter-java.wasm       — copied from node_modules/tree-sitter-java/
 *
 * All .wasm files are bundled in mcp-server/grammars/ and committed to the repo.
 */

import { Parser, Language } from "web-tree-sitter";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// Supported languages
// ---------------------------------------------------------------------------

const SUPPORTED_LANGUAGES = [
  "typescript",
  "tsx",
  "python",
  "bash",
  "java",
] as const;

type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let initialized = false;
const parsers = new Map<string, Parser>();

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a grammar WASM file.
 *
 * Uses import.meta.url so this works in both ESM and Vitest environments.
 * Grammars are located in mcp-server/grammars/ relative to this file's location
 * at mcp-server/src/graph/kg-wasm-parser.ts — two levels up.
 */
function grammarPath(language: SupportedLanguage): string {
  const thisFile = fileURLToPath(import.meta.url);
  const grammarsDir = join(dirname(thisFile), "..", "..", "grammars");
  return join(grammarsDir, `tree-sitter-${language}.wasm`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the WASM runtime and load all grammar files.
 *
 * Must be awaited before calling getParser(). Idempotent — safe to call
 * multiple times; subsequent calls are no-ops.
 *
 * Throws immediately if any grammar file is missing (fail-closed behavior).
 */
export async function initParsers(): Promise<void> {
  if (initialized) return;

  // Initialize the WASM module. The locateFile callback tells the module
  // where to find the web-tree-sitter.wasm runtime file.
  await Parser.init({
    locateFile(scriptName: string): string {
      // scriptName is 'web-tree-sitter.wasm' — resolve it from node_modules
      if (scriptName.endsWith(".wasm")) {
        const thisFile = fileURLToPath(import.meta.url);
        const nodeModulesDir = join(
          dirname(thisFile),
          "..",
          "..",
          "node_modules",
          "web-tree-sitter",
        );
        return join(nodeModulesDir, scriptName);
      }
      return scriptName;
    },
  });

  // Load each grammar and create a dedicated Parser instance per language.
  // Fail-fast: if any grammar file is missing, throw immediately.
  for (const lang of SUPPORTED_LANGUAGES) {
    const wasmPath = grammarPath(lang);
    let language: Language;
    try {
      language = await Language.load(wasmPath);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      throw new Error(
        `kg-wasm-parser: failed to load grammar for '${lang}' from '${wasmPath}': ${message}`,
      );
    }

    const parser = new Parser();
    parser.setLanguage(language);
    parsers.set(lang, parser);
  }

  initialized = true;
}

/**
 * Return the pre-initialized Parser for the given language.
 *
 * Throws if initParsers() has not been called, or if the language is unknown.
 * All WASM complexity is hidden — callers receive a ready-to-use Parser.
 */
export function getParser(language: string): Parser {
  if (!initialized) {
    throw new Error(
      "kg-wasm-parser: initParsers() must be called and awaited before getParser()",
    );
  }
  const parser = parsers.get(language);
  if (!parser) {
    const supported = SUPPORTED_LANGUAGES.join(", ");
    throw new Error(
      `kg-wasm-parser: unknown language '${language}'. Supported languages: ${supported}`,
    );
  }
  return parser;
}

/**
 * Returns true if initParsers() has completed successfully.
 */
export function isInitialized(): boolean {
  return initialized;
}
