import { dirname, join, normalize } from "node:path";
import { JS_EXTENSIONS, PY_EXTENSIONS, RESOLVE_EXTENSIONS } from "../constants.ts";
import { toPosix } from "../utils/paths.ts";

/** Registry of import extractors by file extension. Add new languages here. */
const importExtractors = new Map<string, (content: string) => string[]>();
for (const ext of JS_EXTENSIONS) importExtractors.set(ext, extractJsImports);
for (const ext of PY_EXTENSIONS) importExtractors.set(ext, extractPyImports);

/**
 * Extract import paths from source file content.
 * Returns raw import specifiers (relative paths, package names, etc.)
 */
export function extractImports(content: string, filePath: string): string[] {
  const ext = filePath.split(".").pop() || "";
  const extractor = importExtractors.get(ext);
  return extractor ? extractor(content) : [];
}

const JS_IMPORT_RES = [
  /import\s+(?:[\w{},*\s]+\s+from\s+)?['"]([^'"]+)['"]/g, // ES module
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // Dynamic
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // CommonJS
  /export\s+(?:[\w{},*\s]+\s+from\s+)['"]([^'"]+)['"]/g, // Re-export
];

function extractJsImports(content: string): string[] {
  const imports: string[] = [];

  for (const re of JS_IMPORT_RES) {
    let match = re.exec(content);
    while (match !== null) {
      imports.push(match[1]);
      match = re.exec(content);
    }
  }

  return imports;
}

/** Extract Python import paths. */
function extractPyImports(content: string): string[] {
  const imports: string[] = [];

  // from X import Y
  const fromImportRe = /^from\s+([\w.]+)\s+import/gm;
  let match = fromImportRe.exec(content);
  while (match !== null) {
    imports.push(match[1]);
    match = fromImportRe.exec(content);
  }

  // import X
  const importRe = /^import\s+([\w.]+)/gm;
  match = importRe.exec(content);
  while (match !== null) {
    imports.push(match[1]);
    match = importRe.exec(content);
  }

  return imports;
}

/** A parsed path alias: prefix to match and the directory it maps to */
export type PathAlias = {
  prefix: string; // e.g. "@/" or "~/"
  target: string; // e.g. "src/" — relative to project root
};

/**
 * Parse tsconfig.json compilerOptions.paths into PathAlias entries.
 * Supports patterns like { "@/*": ["./src/*"] } and { "@components/*": ["src/components/*"] }
 */
export function parseTsconfigPaths(paths: Record<string, string[]>, baseUrl?: string): PathAlias[] {
  const aliases: PathAlias[] = [];
  const base = baseUrl ? `${baseUrl.replace(/\/$/, "")}/` : "";

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

/**
 * Mapping from JS-family extensions used in TS ESM import specifiers to the
 * TypeScript source extensions that should be tried instead.
 * e.g. `./store.js` → try `./store.ts` then `./store.tsx`
 */
const ESM_JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx", ".ts"],
  ".mjs": [".mts", ".ts"],
};

/** Try to match a path with extension variants against the file set. */
function tryExtensions(
  base: string,
  extensions: readonly string[],
  allFiles: Set<string>,
): string | null {
  for (const ext of extensions) {
    if (allFiles.has(base + ext)) return base + ext;
  }
  return null;
}

/** Try to resolve a path as an index file within a directory. */
function tryIndexResolution(
  dir: string,
  extensions: readonly string[],
  allFiles: Set<string>,
): string | null {
  for (const ext of extensions) {
    const indexPath = toPosix(join(dir, `index${ext}`));
    if (allFiles.has(indexPath)) return indexPath;
  }
  return null;
}

/** Try ESM JS→TS extension remapping (e.g., .js → .ts/.tsx). */
function tryEsmRemap(posix: string, allFiles: Set<string>): string | null {
  for (const [jsExt, tsExts] of Object.entries(ESM_JS_TO_TS)) {
    if (!posix.endsWith(jsExt)) continue;
    const base = posix.slice(0, -jsExt.length);
    const direct = tryExtensions(base, tsExts, allFiles);
    if (direct) return direct;
    const index = tryIndexResolution(base, tsExts, allFiles);
    if (index) return index;
  }
  return null;
}

/** Try to find a file in the set with extension and index resolution */
function tryResolve(candidate: string, allFiles: Set<string>): string | null {
  const posix = toPosix(candidate);
  if (allFiles.has(posix)) return posix;

  return (
    tryExtensions(posix, RESOLVE_EXTENSIONS, allFiles) ??
    tryIndexResolution(candidate, RESOLVE_EXTENSIONS, allFiles) ??
    tryEsmRemap(posix, allFiles)
  );
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
