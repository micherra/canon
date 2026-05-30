/**
 * Utilities for deriving subsystem keys from file paths.
 *
 * Placed in @shared/lib/ so that features/orchestration tools can import
 * this pure function without violating the no-orchestration-to-drift-direct
 * boundary rule.
 */

/**
 * Derive a subsystem key from a file path.
 *
 * Rules (applied in order):
 * 1. Strip `mcp-server/src/` prefix if present
 * 2. Strip `__tests__/` and implementation leaf directories (`tools/`, `services/`)
 *    to map files up to their parent subsystem
 * 3. Take the directory path (all remaining parts except the filename)
 * 4. If the result is empty or just a filename (no slash), return "root"
 *
 * Examples:
 * - `mcp-server/src/features/orchestration/tools/write-review.ts` → `features/orchestration`
 * - `mcp-server/src/platform/storage/drift/drift-db.ts` → `platform/storage/drift`
 * - `hooks/canon-hook-lib.sh` → `hooks`
 * - `mcp-server/src/features/orchestration/__tests__/foo.test.ts` → `features/orchestration`
 * - `CLAUDE.md` → `root`
 */
export function deriveSubsystemKey(filePath: string): string {
  // Normalize path separators
  let path = filePath.replace(/\\/g, "/");

  // Strip mcp-server/src/ prefix
  const MCP_PREFIX = "mcp-server/src/";
  if (path.startsWith(MCP_PREFIX)) {
    path = path.slice(MCP_PREFIX.length);
  }

  // Strip leaf subdirectories that are implementation details, not subsystem boundaries.
  // These directories exist within a subsystem but don't define it:
  // - __tests__/ : test files map to their parent subsystem
  // - tools/     : tool handlers within a feature
  // - services/  : service implementations within a feature
  path = path.replace(/__tests__\//g, "");
  path = path.replace(/\btools\//g, "");
  path = path.replace(/\bservices\//g, "");

  // Split into parts (remove empty parts from leading/trailing slashes)
  const parts = path.split("/").filter((p) => p.length > 0);

  // Take all parts except the filename (last element)
  const dirParts = parts.slice(0, -1);

  if (dirParts.length === 0) {
    return "root";
  }

  const key = dirParts.join("/");
  return key.length > 0 ? key : "root";
}
