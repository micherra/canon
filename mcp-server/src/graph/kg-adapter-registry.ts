/**
 * Adapter Registry
 *
 * Maps file extensions to the appropriate LanguageAdapter instance.
 * Tree-sitter languages are handled by a factory that pairs the generic
 * walker with the appropriate LanguageConfig.  Markdown and YAML retain
 * their own hand-rolled adapters (no tree-sitter dependency).
 */

import type { LanguageAdapter, AdapterResult } from './kg-types.ts';
import { getParser } from './kg-wasm-parser.ts';
import { walkTree } from './kg-generic-walker.ts';
import { LANGUAGE_CONFIGS, type LanguageConfig } from './kg-language-configs.ts';
import { markdownAdapter } from './kg-adapter-markdown.ts';
import { yamlAdapter } from './kg-adapter-yaml.ts';

// ---------------------------------------------------------------------------
// Factory — build a LanguageAdapter from a LanguageConfig
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Registry — O(1) extension lookup
// ---------------------------------------------------------------------------

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

/**
 * Returns the adapter for a given file extension, or undefined if none
 * is registered. Extension must include the leading dot (e.g. '.ts').
 */
export function getAdapter(extension: string): LanguageAdapter | undefined {
  return registry.get(extension);
}

/**
 * Returns a canonical language name for the given file extension.
 * Used when writing the `language` column in the `files` table.
 * Returns 'unknown' for unrecognised extensions.
 */
export function getLanguage(extension: string): string {
  const langMap: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python',
    '.sh': 'bash',
    '.java': 'java',
    '.md': 'markdown',
    '.yaml': 'yaml', '.yml': 'yaml',
  };
  return langMap[extension] ?? 'unknown';
}
