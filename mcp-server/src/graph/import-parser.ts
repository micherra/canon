import { dirname, join, normalize } from "path";
import { JS_EXTENSIONS, PY_EXTENSIONS, RESOLVE_EXTENSIONS } from "../constants.js";
import { toPosix } from "../utils/paths.js";

/** Registry of import extractors by file extension. Add new languages here. */
const importExtractors = new Map<string, (content: string) => string[]>();
for (const ext of JS_EXTENSIONS) importExtractors.set(ext, extractJsImports);
for (const ext of PY_EXTENSIONS) importExtractors.set(ext, extractPyImports);

/**
 * Extract import paths from source file content.
 * Returns raw import specifiers (relative paths, package names, etc.)
 */
export function extractImports(
  content: string,
  filePath: string
): string[] {
  const ext = filePath.split(".").pop() || "";
  const extractor = importExtractors.get(ext);
  return extractor ? extractor(content) : [];
}

/** Extract JS/TS import paths. */
function extractJsImports(content: string): string[] {
  const imports: string[] = [];

  // ES module imports: import ... from '...'
  const esImportRe = /import\s+(?:[\w{},*\s]+\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = esImportRe.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // Dynamic imports: import('...')
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicRe.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // CommonJS requires: require('...')
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRe.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // Re-exports: export ... from '...'
  const reExportRe = /export\s+(?:[\w{},*\s]+\s+from\s+)['"]([^'"]+)['"]/g;
  while ((match = reExportRe.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

/** Extract Python import paths. */
function extractPyImports(content: string): string[] {
  const imports: string[] = [];

  // from X import Y
  const fromImportRe = /^from\s+([\w.]+)\s+import/gm;
  let match;
  while ((match = fromImportRe.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // import X
  const importRe = /^import\s+([\w.]+)/gm;
  while ((match = importRe.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

/** A parsed path alias: prefix to match and the directory it maps to */
export interface PathAlias {
  prefix: string; // e.g. "@/" or "~/"
  target: string; // e.g. "src/" — relative to project root
}

/**
 * Parse tsconfig.json compilerOptions.paths into PathAlias entries.
 * Supports patterns like { "@/*": ["./src/*"] } and { "@components/*": ["src/components/*"] }
 */
export function parseTsconfigPaths(
  paths: Record<string, string[]>,
  baseUrl?: string,
): PathAlias[] {
  const aliases: PathAlias[] = [];
  const base = baseUrl ? baseUrl.replace(/\/$/, "") + "/" : "";

  for (const [pattern, targets] of Object.entries(paths)) {
    if (!pattern.endsWith("/*") || targets.length === 0) continue;
    const prefix = pattern.slice(0, -1); // "@/*" → "@/"
    let target = targets[0];
    if (!target.endsWith("/*")) continue;
    target = target.slice(0, -1); // "./src/*" → "./src/"
    // Strip leading "./"
    if (target.startsWith("./")) target = target.slice(2);
    aliases.push({ prefix, target: base + target });
  }

  return aliases;
}

/** Try to find a file in the set with extension and index resolution */
function tryResolve(candidate: string, allFiles: Set<string>): string | null {
  const posix = toPosix(candidate);
  if (allFiles.has(posix)) return posix;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (allFiles.has(posix + ext)) return posix + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexPath = toPosix(join(candidate, "index" + ext));
    if (allFiles.has(indexPath)) return indexPath;
  }
  return null;
}

/**
 * Resolve an import to a file path in the project.
 * Handles relative imports and path aliases (e.g. @/ → src/).
 */
export function resolveImport(
  importPath: string,
  fromFile: string,
  allFiles: Set<string>,
  aliases?: PathAlias[],
): string | null {
  // Relative imports
  if (importPath.startsWith(".")) {
    const fromDir = dirname(fromFile);
    const resolved = toPosix(normalize(join(fromDir, importPath)));
    return tryResolve(resolved, allFiles);
  }

  // Path alias resolution
  if (aliases) {
    for (const alias of aliases) {
      if (importPath.startsWith(alias.prefix)) {
        const rest = importPath.slice(alias.prefix.length);
        const resolved = toPosix(normalize(join(alias.target, rest)));
        return tryResolve(resolved, allFiles);
      }
    }
  }

  return null;
}
