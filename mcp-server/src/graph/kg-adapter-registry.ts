/**
 * Adapter Registry
 *
 * Maps file extensions to the appropriate LanguageAdapter instance.
 * All adapters self-declare their extensions; this module simply iterates
 * them at startup and builds a fast O(1) lookup map.
 */

import type { LanguageAdapter } from './kg-types.ts';
import { typescriptAdapter } from './kg-adapter-typescript.ts';
import { pythonAdapter } from './kg-adapter-python.ts';
import { bashAdapter } from './kg-adapter-bash.ts';
import { markdownAdapter } from './kg-adapter-markdown.ts';
import { yamlAdapter } from './kg-adapter-yaml.ts';

const registry = new Map<string, LanguageAdapter>();

// Register all adapters by their declared extensions
for (const adapter of [typescriptAdapter, pythonAdapter, bashAdapter, markdownAdapter, yamlAdapter]) {
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
    '.md': 'markdown',
    '.yaml': 'yaml', '.yml': 'yaml',
  };
  return langMap[extension] ?? 'unknown';
}
