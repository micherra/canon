/**
 * `recall` composite tool handler — one natural-language query, one RRF-fused
 * ranked result set across code, knowledge/docs, decisions, ADRs, and build
 * history, each hit source-tagged.
 *
 * Modelled on `get-context-handler.ts`: same `resolveScope(extra)` + `pluginDir`
 * pattern, same fail-open-per-section shape. Lives in `app/` (the composition
 * root) rather than a `features/recall/` module — `no-cross-feature-internal-
 * import` (ADR-0005) scopes only `features/**`→`features/**`; `app/` already
 * imports across every feature (see `get_context`), so this is legal here and
 * would not be from inside `features/`.
 *
 * Per-store fail-open: each adapter below runs inside `runStore`'s try/catch —
 * a thrown error or a `ToolResult` `ok:false` degrades that store to `[]` and
 * records a `skipped[]` entry; the fused result is built from whatever stores
 * returned. This is the deliberate opposite of Canon's fail-closed safety gates
 * — `recall` is an advisory retrieval surface, not a safety gate.
 */

import { join } from "node:path";
import { getBuildHistory } from "@features/history/tools/get-build-history.ts";
import { searchKnowledge } from "@features/knowledge-graph/tools/search-knowledge.ts";
import { semanticSearch } from "@features/knowledge-graph/tools/semantic-search.ts";
import type { CorpusDecision } from "@features/orchestration/services/decisions-corpus.ts";
import { getDecisionsCorpus } from "@features/orchestration/tools/get-decisions-corpus.ts";
import type { SemanticSearchResult } from "@graph/kg-types.ts";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ArchiveManifestEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import { z } from "zod";
import { rankAdrs } from "./recall-adr-source.ts";
import type { RecallCandidate, RecallHit, RecallStore } from "./recall-fusion.ts";
import { rrfFuse, tokenOverlap } from "./recall-fusion.ts";
import { pluginDir, resolveScope } from "./server-state.ts";

// --- recall composite tool implementation ---

export type RecallSkipped = { store: RecallStore; reason: string };

export type RecallOutput = {
  query: string;
  hits: RecallHit[];
  /** Stores that successfully contributed candidates (possibly zero) to the fan-out. */
  stores_queried: RecallStore[];
  /** Stores that errored during fan-out; never silently dropped. */
  skipped: RecallSkipped[];
};

export const recallInputSchema = {
  limit: z.number().int().positive().max(100).optional().describe("Max fused hits (default 20)"),
  per_store_limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Per-store cap before fusion (default 10)"),
  query: z.string().min(1).describe("Natural-language query"),
  stores: z
    .array(z.enum(["code_kg", "knowledge", "decisions", "adr", "build_history"]))
    .optional()
    .describe("Restrict to specific stores (default all)"),
};

export type RecallInput = {
  query: string;
  limit?: number;
  per_store_limit?: number;
  stores?: RecallStore[];
};

const ALL_STORES: RecallStore[] = ["code_kg", "knowledge", "decisions", "adr", "build_history"];
const DEFAULT_LIMIT = 20;
const DEFAULT_PER_STORE_LIMIT = 10;
const SNIPPET_LEN = 200;

function firstN(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

// --- Per-store adapters — each maps an existing tool's ranked output to RecallCandidate[]. ---
// None throw to the caller directly; a ToolResult ok:false is converted to a thrown Error so
// runStore's try/catch handles every adapter uniformly.

function mapSemanticSearchResult(r: SemanticSearchResult): RecallCandidate {
  return {
    id: `entity:${r.entity_id}`,
    native_score: r.distance,
    path: r.file_path,
    snippet: r.summary ? `${r.qualified_name} — ${r.summary}` : `${r.qualified_name} (${r.kind})`,
    source_store: "code_kg",
  };
}

async function adaptCodeKg(
  query: string,
  dir: string,
  perStoreLimit: number,
): Promise<RecallCandidate[]> {
  const result = await semanticSearch({ limit: perStoreLimit, query }, dir);
  if (!result.ok) throw new Error(`${result.error_code}: ${result.message}`);
  return result.results.map(mapSemanticSearchResult);
}

async function adaptKnowledge(
  query: string,
  dir: string,
  perStoreLimit: number,
): Promise<RecallCandidate[]> {
  const result = await searchKnowledge({ limit: perStoreLimit, query }, dir);
  if (!result.ok) throw new Error(`${result.error_code}: ${result.message}`);
  return result.results.map((r) => ({
    id: `doc:${r.corpus}/${r.doc_path}#${r.chunk_index}`,
    native_score: r.distance,
    path: r.doc_path,
    snippet: firstN(r.content, SNIPPET_LEN),
    source_store: "knowledge",
  }));
}

function scoreDecision(query: string, d: CorpusDecision): number {
  return tokenOverlap(
    query,
    `${d.summary} ${d.rationale ?? ""} ${d.gate ?? ""} ${d.outcome ?? ""}`,
  );
}

async function adaptDecisions(
  query: string,
  dir: string,
  perStoreLimit: number,
): Promise<RecallCandidate[]> {
  const result = await getDecisionsCorpus({ project_dir: dir });
  if (!result.ok) throw new Error(`${result.error_code}: ${result.message}`);
  return result.decisions
    .map((d) => ({ d, score: scoreDecision(query, d) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, perStoreLimit)
    .map(({ d, score }) => ({
      id: `decision:${d.source_slug}#${d.source_event_id}`,
      native_score: score,
      snippet: firstN(d.summary, SNIPPET_LEN),
      source_store: "decisions",
    }));
}

// ArchiveManifestEntry carries no `outcome` field (unlike the m1-03 plan's sketch) — scored
// over the fields that actually exist: flow, branch, slug, task.
function scoreArchive(query: string, a: ArchiveManifestEntry): number {
  return tokenOverlap(query, `${a.flow} ${a.branch} ${a.slug} ${a.task}`);
}

async function adaptBuildHistory(
  query: string,
  dir: string,
  perStoreLimit: number,
): Promise<RecallCandidate[]> {
  const result = await getBuildHistory({ limit: 50, project_dir: dir });
  if (!result.ok) throw new Error(`${result.error_code}: ${result.message}`);
  return result.archives
    .map((a) => ({ a, score: scoreArchive(query, a) }))
    .filter(({ score }) => score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, perStoreLimit)
    .map(({ a, score }) => ({
      id: `build:${a.archive_id}`,
      native_score: score,
      snippet: `${a.flow} ${a.branch} — ${a.task}`.trim(),
      source_store: "build_history",
    }));
}

// --- Fan-out + fail-open wrapper ---

type StoreOutcome =
  | { store: RecallStore; candidates: RecallCandidate[] }
  | { store: RecallStore; skipped: RecallSkipped };

async function runStore(
  store: RecallStore,
  fn: () => Promise<RecallCandidate[]> | RecallCandidate[],
): Promise<StoreOutcome> {
  try {
    const candidates = await fn();
    return { candidates, store };
  } catch (err) {
    return {
      skipped: { reason: err instanceof Error ? err.message : String(err), store },
      store,
    };
  }
}

export async function handleRecall(
  input: RecallInput,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<RecallOutput> {
  // When extra is absent (direct call from tests), pass a stub so resolveScope falls through
  // to the module global via the STDIO sentinel — the absent-extra path is the tested fallback
  // (mirrors handleGetContext).
  const dir = resolveScope(
    (extra ?? {
      requestId: "",
      sessionId: undefined,
      signal: new AbortController().signal,
    }) as RequestHandlerExtra<ServerRequest, ServerNotification>,
  );

  const { query } = input;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const perStoreLimit = input.per_store_limit ?? DEFAULT_PER_STORE_LIMIT;
  const stores = input.stores ?? ALL_STORES;
  const adrDir = join(pluginDir, "docs", "adr");

  const adapters: Record<RecallStore, () => Promise<RecallCandidate[]> | RecallCandidate[]> = {
    adr: () => rankAdrs(query, adrDir, perStoreLimit),
    build_history: () => adaptBuildHistory(query, dir, perStoreLimit),
    code_kg: () => adaptCodeKg(query, dir, perStoreLimit),
    decisions: () => adaptDecisions(query, dir, perStoreLimit),
    knowledge: () => adaptKnowledge(query, dir, perStoreLimit),
  };

  const outcomes = await Promise.all(stores.map((store) => runStore(store, adapters[store])));

  const perStore: Partial<Record<RecallStore, RecallCandidate[]>> = {};
  const skipped: RecallSkipped[] = [];
  const storesQueried: RecallStore[] = [];

  for (const outcome of outcomes) {
    if ("skipped" in outcome) {
      skipped.push(outcome.skipped);
      continue;
    }
    perStore[outcome.store] = outcome.candidates;
    storesQueried.push(outcome.store);
  }

  const hits = rrfFuse(perStore, { limit });

  return { hits, query, skipped, stores_queried: storesQueried };
}
