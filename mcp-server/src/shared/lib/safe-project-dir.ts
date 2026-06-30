import { isAbsolute, sep } from "node:path";

/**
 * Allow-list validation barrier for an untrusted project-dir string before any
 * filesystem access (CodeQL js/path-injection sanitizer; see docs/adr/0029).
 *
 * Returns false (fail-closed) for:
 * - empty string or over-length string (> 4096 bytes)
 * - strings containing NUL bytes or ASCII control characters (0x00–0x1f)
 * - relative paths (not starting with separator)
 * - paths that contain a ".." segment after normalization (traversal attempt)
 *
 * There is no fixed safe root for Canon project dirs (a project can live at any
 * absolute path), so this uses CodeQL's documented allow-list-of-safe-patterns
 * strategy rather than containment. See ADR-0029.
 */
export function isSafeProjectDirInput(dir: string): boolean {
  if (dir.length === 0 || dir.length > 4096) return false;
  if (Array.from(dir).some((c) => c.charCodeAt(0) < 0x20)) return false; // NUL + control chars
  if (!isAbsolute(dir)) return false;
  // Check raw segments for ".." before normalization (normalize resolves ".." away,
  // so a post-normalize check alone misses "/a/../b" style traversal attempts).
  if (dir.split(sep).includes("..")) return false;
  return true;
}
