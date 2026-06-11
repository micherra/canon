/**
 * Adapter Registry
 *
 * Maps file extensions to the appropriate LanguageAdapter instance.
 * Tree-sitter languages are handled by a factory that pairs the generic
 * walker with the appropriate LanguageConfig.  Markdown and YAML retain
 * their own hand-rolled adapters (no tree-sitter dependency).
 */

import { markdownAdapter } from "./kg-adapter-markdown.ts";
import { yamlAdapter } from "./kg-adapter-yaml.ts";
import { walkTree } from "./kg-generic-walker.ts";
import { LANGUAGE_CONFIGS, type LanguageConfig } from "./kg-language-configs.ts";
import type { AdapterResult, LanguageAdapter } from "./kg-types.ts";
import { getParser } from "./kg-wasm-parser.ts";

// Factory — build a LanguageAdapter from a LanguageConfig

function makeAdapter(config: LanguageConfig): LanguageAdapter {
  return {
    extensions: config.extensions,
    parse(filePath: string, content: string): AdapterResult {
      const parser = getParser(config.id);
      const tree = parser.parse(content);
      return walkTree(tree, filePath, config);
    },
  };
}

// Registry — O(1) extension lookup

const registry = new Map<string, LanguageAdapter>();

// Register all tree-sitter language adapters
for (const config of LANGUAGE_CONFIGS.values()) {
  const adapter = makeAdapter(config);
  for (const ext of config.extensions) {
    registry.set(ext, adapter);
  }
}

// Register hand-rolled adapters (no tree-sitter; must not be affected by WASM migration)
for (const adapter of [markdownAdapter, yamlAdapter]) {
  for (const ext of adapter.extensions) {
    registry.set(ext, adapter);
  }
}

// Snapshot of all built-in extensions at module init time.
// Used by registerOverlayAdapters to reject shadowing attempts.
const BUILTIN_EXTENSIONS: ReadonlySet<string> = new Set(registry.keys());

/**
 * Returns the adapter for a given file extension, or undefined if none
 * is registered. Extension must include the leading dot (e.g. '.ts').
 */
export function getAdapter(extension: string): LanguageAdapter | undefined {
  return registry.get(extension);
}

// Overlay language name map — populated by registerOverlayAdapters()
const overlayLangMap = new Map<string, string>();

// Track which extensions were added by overlay registration so they can be
// cleared on the next registerOverlayAdapters call (per-project scoping).
const overlayExtensions = new Set<string>();

/**
 * Register adapters for overlay LanguageConfig entries and populate the
 * overlay language name map. Called from kg-wasm-parser.ts after overlay
 * grammars load successfully.
 *
 * Clears all previously-registered overlay adapters before registering the
 * new set, so that project A's overlays do not persist into project B's
 * pipeline run when project B has no overlays (or different ones).
 * Built-in adapters are never removed.
 *
 * Only entries whose parser was successfully loaded (i.e., parsers.has(id))
 * are registered — the adapter factory calls getParser(id) at parse time,
 * which will throw for any language whose parser didn't load. This matches
 * the fail-open pattern: a skipped overlay grammar means no adapter registered.
 *
 * Extensions that collide with a built-in extension are rejected (skip + warn)
 * so that a bad project-local overlay can never shadow a built-in adapter.
 *
 * @param overlayConfigs - Validated overlay configs (from LANGUAGE_CONFIGS after merge)
 */
export function registerOverlayAdapters(overlayConfigs: LanguageConfig[]): void {
  // Clear previously-registered overlay adapters (project-scope isolation).
  // Never remove built-ins — BUILTIN_EXTENSIONS is the guard.
  for (const ext of overlayExtensions) {
    registry.delete(ext);
    overlayLangMap.delete(ext);
  }
  overlayExtensions.clear();

  for (const config of overlayConfigs) {
    const adapter = makeAdapter(config);
    for (const ext of config.extensions) {
      if (BUILTIN_EXTENSIONS.has(ext)) {
        console.warn(
          `kg-adapter-registry: overlay '${config.id}' lists extension '${ext}' which is already claimed by a built-in adapter — built-in wins, extension skipped`,
        );
        continue;
      }
      registry.set(ext, adapter);
      overlayLangMap.set(ext, config.id);
      overlayExtensions.add(ext);
    }
  }
}

/**
 * Returns the set of extensions currently registered via overlays.
 * Used by the pipeline to include overlay-only extensions in the file scan.
 */
export function getOverlayExtensions(): ReadonlySet<string> {
  return overlayExtensions;
}

/**
 * Returns a canonical language name for the given file extension.
 * Used when writing the `language` column in the `files` table.
 * Falls back to overlay language id for provisioned extensions.
 * Returns 'unknown' for unrecognised extensions.
 */
export function getLanguage(extension: string): string {
  const langMap: Record<string, string> = {
    ".cjs": "javascript",
    ".java": "java",
    ".js": "javascript",
    ".jsx": "javascript",
    ".md": "markdown",
    ".mjs": "javascript",
    ".py": "python",
    ".sh": "bash",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".yaml": "yaml",
    ".yml": "yaml",
  };
  return langMap[extension] ?? overlayLangMap.get(extension) ?? "unknown";
}
