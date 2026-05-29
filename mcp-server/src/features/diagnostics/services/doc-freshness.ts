/**
 * Doc-freshness service — git I/O + assembly for the doc_freshness drift dimension.
 *
 * Two responsibilities, kept thin:
 * 1. Enumerate direction docs: top-level `docs/*.md`, excluding `docs/reference/`
 *    (decision freshness-02).
 * 2. Per doc, compute commits-since-last-sync via git (a deliberately imprecise
 *    repo-wide proxy: `git log -n 1` for the doc's last commit, then
 *    `git rev-list --count <hash>..HEAD`), and decorate it with a decaying
 *    confidence annotation from the pure adapter.
 *
 * Canon principles:
 * - observable-best-effort: every git `!ok` (and empty-log) path logs WARN AND
 *   returns a DocFreshness with a `warning` field — never silently dropped.
 * - errors-are-values: returns DocFreshness[] with per-doc `warning?` rather than
 *   throwing on git failures; a missing docs/ dir returns [].
 * - no-llm-calls-in-mcp-tools: pure git + arithmetic; no LLM SDK.
 * - consistent-abstraction-levels: git I/O lives here; the decay is pure in the
 *   adapter; aggregation is pure in analyzeDrift.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import type { DocFreshness } from "@platform/storage/drift/analyzer.ts";
import { computeFreshnessConfidence } from "@platform/storage/drift/doc-freshness-adapter.ts";
import type { ProcessResult } from "@shared/lib/tool-result.ts";

/** Injectable git seam — defaults to the real gitExec so tests can pass a fake. */
type GitFn = (args: string[], cwd: string) => ProcessResult;

/**
 * Enumerate direction docs: top-level `docs/*.md` only, excluding `docs/reference/`.
 * Returns repo-relative POSIX paths (e.g. "docs/foo.md"). A missing docs/ dir
 * (ENOENT) is an expected state → returns []. Any other read error logs WARN
 * (observable-best-effort) and returns [].
 */
function listDirectionDocs(projectDir: string): string[] {
  try {
    const entries = readdirSync(join(projectDir, "docs"), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => `docs/${e.name}`)
      .filter((rel) => !rel.includes("reference/")); // defensive: never include reference docs
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return []; // no docs/ dir is an expected, quiet state
    console.warn(`[canon] doc-freshness: could not read docs/ dir: ${String(err)}`);
    return [];
  }
}

export function computeDocFreshness(projectDir: string, git: GitFn = gitExec): DocFreshness[] {
  const docs = listDirectionDocs(projectDir);

  const results: DocFreshness[] = docs.map((relPath) => {
    const logRes = git(["log", "-n", "1", "--format=%H", "--", relPath], projectDir);
    if (!logRes.ok || logRes.stdout.trim() === "") {
      console.warn(
        `[canon] doc-freshness: git log failed for ${relPath}: ${logRes.stderr || "no commit"}`,
      );
      return {
        commits_since_sync: 0,
        confidence: computeFreshnessConfidence({ commits_since_sync: 0, doc_path: relPath }),
        doc_path: relPath,
        warning: "could not resolve last-sync commit",
      };
    }

    const lastHash = logRes.stdout.trim();
    const countRes = git(["rev-list", "--count", `${lastHash}..HEAD`], projectDir);
    if (!countRes.ok) {
      console.warn(`[canon] doc-freshness: git rev-list failed for ${relPath}: ${countRes.stderr}`);
      return {
        commits_since_sync: 0,
        confidence: computeFreshnessConfidence({ commits_since_sync: 0, doc_path: relPath }),
        doc_path: relPath,
        warning: "could not count commits since last sync",
      };
    }

    const commits = Number.parseInt(countRes.stdout.trim(), 10) || 0;
    return {
      commits_since_sync: commits,
      confidence: computeFreshnessConfidence({ commits_since_sync: commits, doc_path: relPath }),
      doc_path: relPath,
    };
  });

  // Sort by staleness descending (most commits-behind first) — AC4.
  return results.sort((a, b) => b.commits_since_sync - a.commits_since_sync);
}
