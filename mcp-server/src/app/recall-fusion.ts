/**
 * Pure Reciprocal Rank Fusion (RRF) core for the `recall` composite tool.
 *
 * No I/O, no DB, no `features/`/`platform/` imports — this module holds only
 * the recall type contract and the fusion math, so it can be unit-tested in
 * isolation and reused by both the ADR source reader (`recall-adr-source.ts`)
 * and the composite handler (`recall-handler.ts`).
 */

/** The five source stores `recall` fans out to. */
export type RecallStore = "code_kg" | "knowledge" | "decisions" | "adr" | "build_history";

/** One store's native hit, already in that store's rank order (index 0 = best). */
export type RecallCandidate = {
  source_store: RecallStore;
  /** Stable, store-namespaced id (e.g. "entity:5492", "adr:ADR-0040"). */
  id: string;
  /** File/doc path when applicable. */
  path?: string;
  /** Short human-readable excerpt. */
  snippet: string;
  /** Raw store score when available (distance/overlap); optional. */
  native_score?: number;
};

/** A fused, provenance-tagged result hit. */
export type RecallHit = RecallCandidate & {
  /** Fused score, descending. */
  rrf_score: number;
  /** 1-based rank within its own store (best rank across stores when the id repeats). */
  native_rank: number;
};

export type RrfOptions = {
  /** RRF constant (Cormack et al. default). */
  k?: number;
  /** Per-store multiplier; default 1.0. */
  weights?: Partial<Record<RecallStore, number>>;
  /** Cap on returned hits, applied after fusion. */
  limit?: number;
};

const DEFAULT_K = 60;
const DEFAULT_WEIGHT = 1;

type Accumulator = {
  candidate: RecallCandidate;
  bestRank: number;
  score: number;
};

/**
 * Fuse per-store ranked candidate lists into one descending `RecallHit[]` via
 * Reciprocal Rank Fusion: `rrf(d) = Σ_store weight_store / (k + rank_store(d))`.
 *
 * A candidate's `id` is treated as globally unique and store-namespaced — an id
 * appearing in more than one store accumulates contributions from each (the
 * intended RRF boost), keeping the fields (`source_store`/`snippet`/`path`) and
 * the best (lowest) `native_rank` from its highest-ranked occurrence.
 *
 * Pure and total: never throws; empty input returns `[]`.
 */
export function rrfFuse(
  perStore: Partial<Record<RecallStore, RecallCandidate[]>>,
  opts: RrfOptions = {},
): RecallHit[] {
  const k = opts.k ?? DEFAULT_K;
  const weights = opts.weights ?? {};

  const byId = new Map<string, Accumulator>();

  for (const store of Object.keys(perStore) as RecallStore[]) {
    const candidates = perStore[store];
    if (!candidates || candidates.length === 0) continue;
    const weight = weights[store] ?? DEFAULT_WEIGHT;

    candidates.forEach((candidate, index) => {
      const rank = index + 1;
      const contribution = weight / (k + rank);
      const existing = byId.get(candidate.id);
      if (!existing) {
        byId.set(candidate.id, { bestRank: rank, candidate, score: contribution });
        return;
      }
      existing.score += contribution;
      if (rank < existing.bestRank) {
        existing.bestRank = rank;
        existing.candidate = candidate;
      }
    });
  }

  const hits: RecallHit[] = Array.from(byId.values()).map(({ candidate, bestRank, score }) => ({
    ...candidate,
    native_rank: bestRank,
    rrf_score: score,
  }));

  hits.sort((a, b) => {
    if (b.rrf_score !== a.rrf_score) return b.rrf_score - a.rrf_score;
    if (a.source_store !== b.source_store) return a.source_store < b.source_store ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return opts.limit !== undefined ? hits.slice(0, opts.limit) : hits;
}

const MIN_OVERLAP_TOKEN_LEN = 3;

function overlapTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= MIN_OVERLAP_TOKEN_LEN,
  );
}

/**
 * Count of distinct `query` tokens (length ≥ 3, case-insensitive) that appear in
 * `text`. Shared lexical scorer for the `decisions` and `build_history` recall
 * adapters (`recall-handler.ts`) — both rank a store with no native vector score
 * by the same simple, deterministic overlap measure.
 *
 * Pure and total: never throws; no overlap or empty input returns `0`.
 */
export function tokenOverlap(query: string, text: string): number {
  const queryTokens = new Set(overlapTokens(query));
  const textTokens = new Set(overlapTokens(text));
  let score = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) score += 1;
  }
  return score;
}
