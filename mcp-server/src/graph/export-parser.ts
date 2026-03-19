import { JS_EXTENSIONS, PY_EXTENSIONS } from "../constants.js";

/** Registry of export extractors by file extension. Add new languages here. */
const exportExtractors = new Map<string, (content: string) => string[]>();
for (const ext of JS_EXTENSIONS) exportExtractors.set(ext, extractJsExports);
for (const ext of PY_EXTENSIONS) exportExtractors.set(ext, extractPyExports);

/**
 * Extract exported names from source file content.
 * Returns an array of exported identifiers (function names, class names, constants, etc.)
 */
export function extractExports(content: string, filePath: string): string[] {
  const ext = filePath.split(".").pop() || "";
  const extractor = exportExtractors.get(ext);
  return extractor ? extractor(content) : [];
}

function extractJsExports(content: string): string[] {
  const exports: string[] = [];
  const seen = new Set<string>();

  function add(name: string) {
    const trimmed = name.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      exports.push(trimmed);
    }
  }

  // export function name / export async function name
  const funcRe = /export\s+(?:async\s+)?function\s+(\w+)/g;
  let match;
  while ((match = funcRe.exec(content)) !== null) {
    add(match[1]);
  }

  // export class Name
  const classRe = /export\s+class\s+(\w+)/g;
  while ((match = classRe.exec(content)) !== null) {
    add(match[1]);
  }

  // export interface Name / export type Name
  const typeRe = /export\s+(?:interface|type)\s+(\w+)/g;
  while ((match = typeRe.exec(content)) !== null) {
    add(match[1]);
  }

  // export const/let/var name
  const varRe = /export\s+(?:const|let|var)\s+(\w+)/g;
  while ((match = varRe.exec(content)) !== null) {
    add(match[1]);
  }

  // export enum Name
  const enumRe = /export\s+enum\s+(\w+)/g;
  while ((match = enumRe.exec(content)) !== null) {
    add(match[1]);
  }

  // export default function name / export default class Name
  const defaultFuncRe = /export\s+default\s+(?:async\s+)?function\s+(\w+)/g;
  while ((match = defaultFuncRe.exec(content)) !== null) {
    add(match[1]);
  }
  const defaultClassRe = /export\s+default\s+class\s+(\w+)/g;
  while ((match = defaultClassRe.exec(content)) !== null) {
    add(match[1]);
  }

  // Named exports: export { a, b, c }
  const namedRe = /export\s*\{([^}]+)\}/g;
  while ((match = namedRe.exec(content)) !== null) {
    const names = match[1].split(",");
    for (const name of names) {
      // Handle "name as alias" — take the alias
      const parts = name.trim().split(/\s+as\s+/);
      const exported = parts.length > 1 ? parts[1].trim() : parts[0].trim();
      if (exported) add(exported);
    }
  }

  return exports;
}

function extractPyExports(content: string): string[] {
  const exports: string[] = [];
  const seen = new Set<string>();

  function add(name: string) {
    const trimmed = name.trim();
    if (trimmed && !trimmed.startsWith("_") && !seen.has(trimmed)) {
      seen.add(trimmed);
      exports.push(trimmed);
    }
  }

  // __all__ = ['name1', 'name2']
  const allRe = /__all__\s*=\s*\[([^\]]+)\]/;
  const allMatch = allRe.exec(content);
  if (allMatch) {
    const names = allMatch[1].match(/['"](\w+)['"]/g);
    if (names) {
      for (const n of names) {
        add(n.replace(/['"]/g, ""));
      }
    }
    return exports; // __all__ is authoritative
  }

  // Top-level def and class definitions
  const defRe = /^def\s+(\w+)/gm;
  let match;
  while ((match = defRe.exec(content)) !== null) {
    add(match[1]);
  }

  const classRe = /^class\s+(\w+)/gm;
  while ((match = classRe.exec(content)) !== null) {
    add(match[1]);
  }

  return exports;
}
