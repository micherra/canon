/**
 * Frontmatter splitter — the single seam for YAML frontmatter parsing.
 *
 * Backed by the `yaml` (eemeli) library — replaces `gray-matter` while
 * preserving its exact `{ data, body }` contract on Canon's corpus.
 *
 * Behavior contract (pinned by PROBE-FINDINGS P3):
 * - No leading `---` fence → `{ data: {}, body: content }` (no-frontmatter).
 * - Empty / comment-only fence → `YAML.parse` returns `null` → coalesced to `{}`
 *   (matches gray-matter's `data: {}`).
 * - Malformed YAML → the `YAML.parse` error PROPAGATES (we do NOT catch it).
 *   This keeps the crash-vs-swallow contract of every current call site: callers
 *   that already wrap in try/catch keep their wrappers; `parseFrontmatter` (which
 *   does not) keeps throwing on malformed frontmatter.
 * - Block scalars (`>-`, `|`), inline arrays, nested maps, quotes are parsed
 *   byte-equivalently to gray-matter (P3a).
 *
 * Pure, no I/O. Single-concern `lib/` file.
 */

import { parse as parseYaml } from "yaml";

/** Matches a leading frontmatter fence and captures the inner YAML block. */
const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split markdown `content` into its frontmatter `data` object and the remaining
 * `body`. See the module docstring for the full behavior contract.
 */
export function splitFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const match = FRONTMATTER_FENCE.exec(content);
  if (!match) {
    return { body: content, data: {} };
  }

  const block = match[1];
  // Propagates on malformed YAML (A3); coalesces empty/comment-only null to {} (A4).
  const parsed = parseYaml(block);
  return {
    body: content.slice(match[0].length),
    data: (parsed ?? {}) as Record<string, unknown>,
  };
}
