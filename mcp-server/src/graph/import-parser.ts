import { dirname, join, resolve } from "path";

/**
 * Extract import paths from source file content.
 * Returns raw import specifiers (relative paths, package names, etc.)
 */
export function extractImports(
  content: string,
  filePath: string
): string[] {
  const imports: string[] = [];
  const ext = filePath.split(".").pop() || "";

  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) {
    imports.push(...extractJsImports(content));
  } else if (ext === "py") {
    imports.push(...extractPyImports(content));
  }

  return imports;
}

/**
 * Extract JS/TS import paths.
 */
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

/**
 * Extract Python import paths.
 */
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

/**
 * Resolve a relative import to an absolute file path.
 * Returns null for non-relative imports (npm packages, etc.)
 */
export function resolveImport(
  importPath: string,
  fromFile: string,
  allFiles: Set<string>
): string | null {
  // Only resolve relative imports
  if (!importPath.startsWith(".")) return null;

  const fromDir = dirname(fromFile);
  const resolved = join(fromDir, importPath);

  // Try exact match first
  if (allFiles.has(resolved)) return resolved;

  // Try with common extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"];
  for (const ext of extensions) {
    const withExt = resolved + ext;
    if (allFiles.has(withExt)) return withExt;
  }

  // Try index files
  for (const ext of extensions) {
    const indexPath = join(resolved, "index" + ext);
    if (allFiles.has(indexPath)) return indexPath;
  }

  return null;
}
