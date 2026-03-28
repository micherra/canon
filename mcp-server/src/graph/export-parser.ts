import { JS_EXTENSIONS, PY_EXTENSIONS } from "../constants.ts";

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

const JS_EXPORT_RES = [
  { re: /export\s+(?:async\s+)?function\s+(\w+)/g, type: "func" },
  { re: /export\s+class\s+(\w+)/g, type: "class" },
  { re: /export\s+(?:interface|type)\s+(\w+)/g, type: "type" },
  { re: /export\s+(?:const|let|var)\s+(\w+)/g, type: "var" },
  { re: /export\s+enum\s+(\w+)/g, type: "enum" },
  { re: /export\s+default\s+(?:async\s+)?function\s+(\w+)/g, type: "defaultFunc" },
  { re: /export\s+default\s+class\s+(\w+)/g, type: "defaultClass" },
];

function extractJsExports(content: string): string[] {
  const exports = new Set<string>();

  for (const { re } of JS_EXPORT_RES) {
    let match;
    while ((match = re.exec(content)) !== null) {
      if (match[1]) exports.add(match[1].trim());
    }
  }

  // Named exports: export { a, b, c }
  const namedRe = /export\s*\{([^}]+)\}/g;
  let match;
  while ((match = namedRe.exec(content)) !== null) {
    for (const name of match[1].split(",")) {
      const parts = name.trim().split(/\s+as\s+/);
      const exported = (parts.length > 1 ? parts[1] : parts[0]).trim();
      if (exported) exports.add(exported);
    }
  }

  return Array.from(exports);
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
