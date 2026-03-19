import { readFile } from "fs/promises";
import { join } from "path";
import { parseTsconfigPaths, type PathAlias } from "../graph/import-parser.js";

/** Normalize a path to forward slashes so it matches git output on all platforms. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Load TypeScript path aliases from tsconfig.json, returning [] if unavailable. */
export async function loadPathAliases(projectDir: string): Promise<PathAlias[]> {
  try {
    const raw = await readFile(join(projectDir, "tsconfig.json"), "utf-8");
    const tsconfig = JSON.parse(raw);
    const paths = tsconfig?.compilerOptions?.paths;
    if (paths && typeof paths === "object") {
      return parseTsconfigPaths(paths, tsconfig.compilerOptions.baseUrl);
    }
  } catch {
    // no tsconfig or invalid
  }
  return [];
}
