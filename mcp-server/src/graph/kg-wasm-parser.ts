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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { type LanguageConfig, mergeOverlayIntoConfigs } from "./kg-language-configs.ts";
import { loadOverlayConfigs, overlayGrammarPath } from "./kg-language-overlay.ts";

// Supported built-in languages (fail-closed on load)

const SUPPORTED_LANGUAGES = ["typescript", "tsx", "python", "bash", "java"] as const;

type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// Module-level state

let initialized = false;
const parsers = new Map<string, Parser>();

// Path resolution

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

/** Initialize the web-tree-sitter WASM runtime. */
async function initWasmRuntime(): Promise<void> {
  await Parser.init({
    locateFile(scriptName: string): string {
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
}

/**
 * Load all built-in grammars (fail-closed: throws if any grammar is missing).
 * Called once before overlay loading so built-ins are always available.
 */
async function loadBuiltinGrammars(): Promise<void> {
  for (const lang of SUPPORTED_LANGUAGES) {
    const wasmPath = grammarPath(lang);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: fail-fast sequential load — each grammar must succeed before the next is attempted
      const language = await Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(language);
      parsers.set(lang, parser);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `kg-wasm-parser: failed to load grammar for '${lang}' from '${wasmPath}': ${message}`,
      );
    }
  }
}

/**
 * Load project-local overlay grammars (fail-open: skip + log on any error).
 * Returns the configs whose grammars loaded successfully.
 *
 * Registration is ATOMIC per language: a config is merged into LANGUAGE_CONFIGS/
 * EXT_TO_CONFIG only after Language.load() succeeds. A failed load leaves no
 * partial state in the config maps — the extension will simply be unsupported.
 */
async function loadOverlayGrammars(projectDir: string): Promise<LanguageConfig[]> {
  const builtinIds = new Set(SUPPORTED_LANGUAGES as unknown as string[]);
  const overlayConfigs = loadOverlayConfigs(projectDir, builtinIds);
  if (overlayConfigs.length === 0) return [];

  const loaded: LanguageConfig[] = [];
  // Track overlay ids seen so far to reject duplicates (first-wins policy).
  // Without this guard, a second config with the same id would overwrite the
  // first's parser in `parsers`, while both configs would land in `loaded` and
  // register adapters — the first adapter's getParser() call would then resolve
  // the second config's parser, producing a language id / parser mismatch.
  const seenOverlayIds = new Set<string>();

  for (const config of overlayConfigs) {
    // Duplicate overlay id: first-wins, skip later duplicates with a warning.
    if (seenOverlayIds.has(config.id)) {
      console.warn(
        `kg-wasm-parser: duplicate overlay id '${config.id}' — first-wins, skipping later entry`,
      );
      continue;
    }

    // Mark this id as seen BEFORE attempting Language.load() so that a later
    // duplicate is rejected even when the first entry's load fails.
    seenOverlayIds.add(config.id);

    const wasmPath = overlayGrammarPath(projectDir, config.grammarFile);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: overlay grammars are few; sequential is fine here
      const language = await Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(language);
      parsers.set(config.id, parser);
      loaded.push(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `kg-wasm-parser: failed to load overlay grammar for '${config.id}' from '${wasmPath}': ${message} — skipping`,
      );
    }
  }

  // Merge only successfully-loaded configs into the shared maps.
  // This ensures LANGUAGE_CONFIGS and EXT_TO_CONFIG never contain an entry
  // whose parser/adapter does not exist (no half-registered state).
  if (loaded.length > 0) {
    mergeOverlayIntoConfigs(loaded);
  }

  return loaded;
}

/**
 * Initialize the WASM runtime and load all grammar files.
 *
 * Must be awaited before calling getParser(). The WASM runtime and built-in
 * grammars are initialized only once (idempotent). Overlay grammars are
 * resolved per call when `projectDir` is provided — subsequent calls with a
 * new `projectDir` will register that project's overlays even though the
 * parser singleton was already initialized.
 *
 * Built-in grammar loading is fail-closed: a missing built-in grammar throws.
 * Overlay grammar loading (when projectDir is provided) is fail-open: a
 * missing or malformed overlay wasm is logged and skipped — the built-in
 * set always initializes successfully.
 *
 * @param projectDir - Optional project root for loading overlay grammars from
 *   `.canon/grammars/`. When omitted, only built-in grammars are loaded.
 * @returns The overlay LanguageConfig entries whose grammars loaded successfully.
 *   Callers should pass this to `registerOverlayAdapters()` in kg-adapter-registry.ts.
 *   Returns [] when projectDir is omitted or no overlays are found.
 */
export async function initParsers(projectDir?: string): Promise<LanguageConfig[]> {
  if (!initialized) {
    await initWasmRuntime();
    await loadBuiltinGrammars();
    initialized = true;
  }
  // Overlay resolution is per-projectDir: even when the singleton is already
  // initialized, a second project with .canon/kg-languages must get its own
  // overlays registered. Without this, a second project's overlays are silently
  // dropped because the early-return above skips loadOverlayGrammars entirely.
  const loadedOverlayConfigs = projectDir ? await loadOverlayGrammars(projectDir) : [];
  return loadedOverlayConfigs;
}

/**
 * Return the pre-initialized Parser for the given language.
 *
 * Throws if initParsers() has not been called, or if the language is unknown.
 * All WASM complexity is hidden — callers receive a ready-to-use Parser.
 */
export function getParser(language: string): Parser {
  if (!initialized) {
    throw new Error("kg-wasm-parser: initParsers() must be called and awaited before getParser()");
  }
  const parser = parsers.get(language);
  if (!parser) {
    const allLoaded = [...parsers.keys()].join(", ");
    throw new Error(
      `kg-wasm-parser: unknown language '${language}'. Loaded languages: ${allLoaded}`,
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
