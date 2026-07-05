/**
 * get_decisions_corpus — offline, cross-workspace decisions reader + aggregator.
 *
 * Thin `ToolResult` wrapper over `buildDecisionsCorpus`/`aggregateDecisions`/
 * `renderCorpus` (see `services/decisions-corpus.ts` for the two-partition
 * union logic). Sibling of `get_decisions` (decisions-ledger.ts), which reads
 * a single workspace's live ledger; this tool reads across every workspace —
 * live-on-disk and durably-persisted-after-reap — in one call.
 *
 * Offline + deterministic: no network, pure sort by decided_at/source_slug/
 * source_event_id (no clock-dependent ordering).
 */

import { isAbsolute } from "node:path";
import {
  type Aggregation,
  aggregateDecisions,
  buildDecisionsCorpus,
  type CorpusDecision,
  renderCorpus,
  type SkippedStore,
} from "@features/orchestration/services/decisions-corpus.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

/**
 * Input for the get_decisions_corpus query.
 *
 * @param project_dir - Absolute path to the project root (injected by
 *   `resolveScope(extra)` server-side — see register-journal.ts).
 */
export type GetDecisionsCorpusInput = { project_dir: string };

/** Return value for the get_decisions_corpus query. */
export type GetDecisionsCorpusResult = {
  decisions: CorpusDecision[];
  aggregation: Aggregation;
  skipped: SkippedStore[];
  rendered: string;
};

/**
 * Read the full cross-workspace decisions corpus (live + durable partitions),
 * aggregate it, and render a markdown summary.
 *
 * Fail-open: `buildDecisionsCorpus` degrades each partition independently —
 * a fully unreadable corpus returns an empty-but-ok result, never a thrown
 * error. Only a malformed `project_dir` input surfaces as `INVALID_INPUT`.
 *
 * @param input - `{ project_dir }`.
 * @returns `{ decisions, aggregation, skipped, rendered }` on success.
 * @returns ToolResult error on invalid input.
 */
export async function getDecisionsCorpus(
  input: GetDecisionsCorpusInput,
): Promise<ToolResult<GetDecisionsCorpusResult>> {
  const { project_dir } = input;

  if (!project_dir || !isAbsolute(project_dir)) {
    return toolError(
      "INVALID_INPUT",
      `project_dir must be a non-empty absolute path; got: "${project_dir}"`,
    );
  }

  const { decisions, skipped } = buildDecisionsCorpus(project_dir);
  const aggregation = aggregateDecisions(decisions);
  const rendered = renderCorpus(decisions, aggregation);

  return toolOk({ aggregation, decisions, rendered, skipped });
}
