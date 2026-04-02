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
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      imports.push(match[1]);
    }
  }

  return imports;
}

/** Extract Python import paths. */
function extractPyImports(content: string): string[] {
  const imports: string[] = [];

  // from X import Y
  const fromImportRe = /^from\s+([\w.]+)\s+import/gm;
  let match: RegExpExecArray | null;
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

/** Try direct match or extension-appended match. */
function tryDirectOrExtension(posix: string, allFiles: Set<string>): string | null {
  if (allFiles.has(posix)) return posix;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (allFiles.has(posix + ext)) return posix + ext;
  }
  return null;
}

/** Try index file resolution (e.g. dir/index.ts). */
function tryIndexResolution(candidate: string, allFiles: Set<string>, extensions: readonly string[]): string | null {
  for (const ext of extensions) {
    const indexPath = toPosix(join(candidate, `index${ext}`));
    if (allFiles.has(indexPath)) return indexPath;
  }
  return null;
}

/** Try resolving a .js/.jsx/.mjs specifier to its .ts/.tsx/.mts source. */
function tryEsmTsResolution(posix: string, allFiles: Set<string>): string | null {
  for (const [jsExt, tsExts] of Object.entries(ESM_JS_TO_TS)) {
    if (!posix.endsWith(jsExt)) continue;
    const base = posix.slice(0, -jsExt.length);
    for (const tsExt of tsExts) {
      if (allFiles.has(base + tsExt)) return base + tsExt;
    }
    const indexMatch = tryIndexResolution(base, allFiles, tsExts);
    if (indexMatch) return indexMatch;
  }
  return null;
}

/** Try to find a file in the set with extension and index resolution */
function tryResolve(candidate: string, allFiles: Set<string>): string | null {
  const posix = toPosix(candidate);

  return (
    tryDirectOrExtension(posix, allFiles) ??
    tryIndexResolution(candidate, allFiles, RESOLVE_EXTENSIONS) ??
    tryEsmTsResolution(posix, allFiles)
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
