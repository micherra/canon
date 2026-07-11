/**
 * backfill-applying-commit.ts — backfill_applying_commit MCP tool handler.
 *
 * Populates `applied_evolutions.applying_commit` from `Canon-Evolution: {proposal_id}`
 * git trailers (ADR-0034 back-fill-from-trailer design; Inc-3). The producer
 * (review-learnings.md apply path) writes the trailer only — this tool is the
 * SOLE writer of `applying_commit`.
 *
 * Posture: OBSERVABLE-BEST-EFFORT (not fail-closed like record_applied_evolution).
 * A git or storage failure returns a `ToolResult` error; the caller (the
 * review-learnings command) surfaces a warning but never blocks or undoes an
 * apply on this tool's failure. `record_applied_evolution` stays the
 * authoritative write path — this tool only reconciles a nullable column.
 *
 * Charset guard (dc-05, validate-at-trust-boundaries): `parseEvolutionTrailers`
 * accepts a trailer value ONLY when it matches `^[A-Za-z0-9._-]+$` — this is the
 * backfill-side half of the trailer-injection / id-spoofing guard (the other
 * half runs at the producer commit sink, before interpolation).
 *
 * ADR-002: ToolResult contract; git access routed through git-adapter.ts (no
 * node:child_process here). no-llm-calls-in-mcp-tools: pure git-read + SQL
 * UPDATE, zero model calls.
 * no-cross-feature-internal-import: imports only @platform/* + @shared/lib.
 */

import { gitExec } from "@platform/adapters/git-adapter.ts";
import type { BackfillPair } from "@platform/storage/drift/applied-evolutions-dao.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const DEFAULT_MAX_COMMITS = 2000;

const MAX_COMMITS_CAP = 100_000;

export const BackfillApplyingCommitInputSchema = z.object({
  max_commits: z
    .number()
    .int()
    .positive()
    .max(MAX_COMMITS_CAP)
    .optional()
    .describe(
      `git-log scan cap (bounds the history walk). Default ${DEFAULT_MAX_COMMITS}. ` +
        `Must be positive; capped at ${MAX_COMMITS_CAP}.`,
    ),
  project_dir: z
    .string()
    .describe("Absolute path to the project root (contains .canon/). Drift.db lives under it."),
});

type BackfillApplyingCommitInput = z.input<typeof BackfillApplyingCommitInputSchema>;

// ---------------------------------------------------------------------------
// Trailer parsing (pure)
// ---------------------------------------------------------------------------

/** git-log commit-block delimiter used by the `--format` invocation below. */
const COMMIT_BLOCK_DELIMITER = "==END==";

/**
 * dc-05 charset guard — the same closed charset enforced at the producer commit
 * sink before interpolation. A trailer value that fails this test is skipped,
 * never joined to a DAO row.
 */
const PROPOSAL_ID_CHARSET = /^[A-Za-z0-9._-]+$/;

const CANON_EVOLUTION_TRAILER_LINE = /^Canon-Evolution:\s*(\S+)\s*$/;

/**
 * Split raw `git log --format=%H%n%B%n==END==` stdout into per-commit blocks.
 * Each block's first line is the commit sha; the rest is the commit body
 * (subject + trailers).
 */
function splitCommitBlocks(logText: string): string[] {
  return logText
    .split(COMMIT_BLOCK_DELIMITER)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/**
 * Scan a commit body's lines for the first Canon-Evolution trailer line and
 * return its value — but only when the value passes the dc-05 charset guard.
 * A present-but-invalid trailer yields `null` (skipped, not a fallback scan).
 */
function findTrailerProposalId(bodyLines: string[]): string | null {
  for (const line of bodyLines) {
    const match = line.match(CANON_EVOLUTION_TRAILER_LINE);
    if (!match) continue;
    const proposalId = match[1];
    return PROPOSAL_ID_CHARSET.test(proposalId) ? proposalId : null; // dc-05
  }
  return null;
}

/**
 * Extract a `{proposal_id, sha}` pair from one commit block (first line = sha,
 * remaining lines = commit body). Returns `null` when the block has no sha or
 * no charset-valid Canon-Evolution trailer.
 */
function extractPairFromBlock(block: string): BackfillPair | null {
  const lines = block.split("\n");
  const sha = lines[0]?.trim();
  if (!sha) return null;
  const proposalId = findTrailerProposalId(lines.slice(1));
  if (!proposalId) return null;
  return { applying_commit: sha, proposal_id: proposalId };
}

/**
 * Parse `Canon-Evolution: {proposal_id}` trailers out of `git log` output.
 *
 * - One pair per commit, at most (a commit carries at most one Canon-Evolution
 *   trailer by construction of the producer).
 * - Charset-invalid values (dc-05) are skipped — never surfaced as a pair.
 * - Deduped by proposal_id: first-seen sha wins (git log is newest-first, so
 *   "first-seen" is the most recent commit carrying that trailer).
 *
 * Pure — no I/O, invoked directly by the handler and by unit tests.
 */
export function parseEvolutionTrailers(logText: string): BackfillPair[] {
  const seen = new Set<string>();
  const pairs: BackfillPair[] = [];

  for (const block of splitCommitBlocks(logText)) {
    const pair = extractPairFromBlock(block);
    if (!pair || seen.has(pair.proposal_id)) continue;
    seen.add(pair.proposal_id);
    pairs.push(pair);
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * backfill_applying_commit — best-effort-visible back-fill of `applying_commit`.
 *
 * Reads `Canon-Evolution:` trailers from `git log`, parses `{proposal_id, sha}`
 * pairs (charset-guarded), and applies them via the DAO's null-only, idempotent
 * UPDATE. Never writes when a value is already set (COALESCE-safe by SQL guard).
 *
 * @returns `{ ok: true, updated, scanned }` on success; `INVALID_INPUT` for an
 *   empty `project_dir` or a non-positive/oversized `max_commits`; `UNEXPECTED`
 *   on a git or storage failure. Never throws.
 *   Observable-best-effort: the caller surfaces an error but does not block or
 *   undo an apply on failure — `record_applied_evolution` stays authoritative.
 */
export async function backfillApplyingCommit(
  input: BackfillApplyingCommitInput,
): Promise<ToolResult<{ updated: number; scanned: number }>> {
  const { project_dir } = input;

  if (!project_dir) {
    return toolError("INVALID_INPUT", "project_dir must be a non-empty string.", false);
  }

  if (
    input.max_commits !== undefined &&
    (!Number.isInteger(input.max_commits) ||
      input.max_commits <= 0 ||
      input.max_commits > MAX_COMMITS_CAP)
  ) {
    return toolError(
      "INVALID_INPUT",
      `max_commits must be a positive integer no greater than ${MAX_COMMITS_CAP}.`,
      false,
    );
  }

  const maxCommits = input.max_commits ?? DEFAULT_MAX_COMMITS;

  const logResult = gitExec(
    [
      "log",
      `--format=%H%n%B%n${COMMIT_BLOCK_DELIMITER}`,
      "--grep=^Canon-Evolution:",
      "-E",
      "-n",
      String(maxCommits),
    ],
    project_dir,
  );
  if (!logResult.ok) {
    return toolError(
      "UNEXPECTED",
      `git log failed while scanning for Canon-Evolution trailers: ${logResult.stderr || logResult.stdout || "unknown error"}`,
      false,
    );
  }

  const pairs = parseEvolutionTrailers(logResult.stdout);

  try {
    const updated = getDriftDb(project_dir).getAppliedEvolutions().backfillApplyingCommit(pairs);
    return toolOk({ scanned: pairs.length, updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError("UNEXPECTED", `applying_commit backfill failed: ${message}`, false);
  }
}
