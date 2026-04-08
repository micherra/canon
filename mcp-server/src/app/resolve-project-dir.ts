import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the project directory using the MCP roots priority chain.
 *
 * Priority:
 *   1. CANON_PROJECT_DIR env var (only when set AND is an absolute path)
 *   2. roots/list first root from MCP client
 *   3. cwdFallback
 *
 * @param canonProjectDir - Value of CANON_PROJECT_DIR env var (may be undefined or relative)
 * @param listRootsFn     - Injected function to call the MCP roots/list endpoint
 * @param cwdFallback     - Fallback path when roots cannot be resolved
 */
export async function resolveProjectDir(
  canonProjectDir: string | undefined,
  listRootsFn: () => Promise<{ roots: Array<{ uri: string; name?: string }> }>,
  cwdFallback: string,
): Promise<string> {
  // Priority 1: explicit absolute path override.
  if (canonProjectDir && isAbsolute(canonProjectDir)) {
    console.error(`[canon] project dir from CANON_PROJECT_DIR: ${canonProjectDir}`);
    return canonProjectDir;
  }

  // Priority 2: first root from MCP client.
  try {
    const result = await listRootsFn();
    const firstRoot = result.roots[0];
    if (firstRoot?.uri) {
      const dir = fileURLToPath(firstRoot.uri);
      console.error(`[canon] project dir from MCP roots: ${dir}`);
      return dir;
    }
  } catch {
    // Fall through — client doesn't support roots.
  }

  // Priority 3: cwd fallback.
  console.error(`[canon] project dir from cwd (roots unavailable): ${cwdFallback}`);
  return cwdFallback;
}
