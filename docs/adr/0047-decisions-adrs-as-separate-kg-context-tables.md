---
adr: "0047"
title: "Decisions and ADRs modeled as a separate KG context table-pair with a record_kind subtype, content-hash-gated"
status: accepted
date: "2026-07-10"
build: "unified-agent-memory-m2-decisionsadrs-as-a-traversable-context-graph-kg"
---

# ADR-0047: Decisions/ADRs as a separate KG context table-pair with a record_kind subtype, content-hash-gated

## Context

Unified Agent Memory M1 (#478) delivered fused `recall` retrieval over 5 flat stores. But decisions
and ADRs remained untraversable prose — there was no way to ask the knowledge graph "which decisions
touched this file?", "which principle does this decision cite?", or "what supersedes this ADR?".
Decisions/ADRs carry exactly the causal structure (decision→file, decision→principle, ADR SUPERSEDES
ADR, build→decision) a graph is built to answer, yet they lived entirely outside the KG.

M2 promotes them into the existing SQLite KG. Three structural choices are hard-to-reverse once the
schema ships and downstream tooling depends on it, so they are recorded here rather than left as
ephemeral workspace decisions.

## Options Considered

### 1. Where do decision/ADR nodes live?

- **(A) Reuse the existing `files`/`entities` tables.** Zero new tables. But a decision is not a code
  entity — it has no `file_id`, no source span, no import edges. Forcing it in pollutes every existing
  entity query (`callers`, `blast_radius`, `dead_code`, FTS `search`) with rows that are not code, and
  distorts blast-radius/hub math. Rejected.
- **(B) A dedicated `context_nodes` + `context_edges` table-pair (chosen).** A decision, ADR, or build
  is a distinct record class with its own edge vocabulary. Separate tables keep the code graph clean and
  the context graph independently queryable. An ADR that already has a `doc` file row links to it by
  path via a `decision_touches_file` edge — no duplication.

### 2. One node table or one table per record kind?

- **(A) Distinct `decisions` / `adrs` / `builds` tables.** Physically separates the kinds, but they
  share the ENTIRE edge vocabulary, so every traversal would union three tables and every edge join
  would branch on kind. Rejected.
- **(B) One `context_nodes` table with a `record_kind` discriminator (`decision`|`adr`|`build`)
  (chosen).** A single traversal surface keeps `graph_query` ergonomics simple; `record_kind`
  preserves the distinction without multiplying tables or joins.

### 3. What gates re-ingest freshness?

- **(A) `graph_head_commit` (the structural KG's git-HEAD marker).** Decisions live in `.canon/**`
  SQLite (`orchestration.db`, `drift.db`) and mutate WITHOUT git commits, so a git-HEAD gate would
  never fire for them — the context graph would go permanently stale. Rejected.
- **(B) A content-hash marker `context_graph_hash` over (decisions signature ⊕ ADR file stat-walk),
  single-flight, fail-open (chosen).** This is the exact mechanism `doc_corpus_hash` uses (ADR-0029)
  and for the same reason — corpus sources that mutate without commits.

## Decision

Model decisions/ADRs/builds as a **separate KG table-pair** — `context_nodes(node_id PK, record_kind,
title, ref_slug, source_event_id, adr_number, status, body_excerpt, updated_at)` and
`context_edges(src, dst, edge_type, evidence, PRIMARY KEY(src,dst,edge_type))` — added by a
forward-only, version-gated `IF NOT EXISTS` **schema v7** migration (`SCHEMA_VERSION "6"→"7"`). Use
**one node table with a `record_kind` subtype**, not distinct per-kind tables. Populate it with a
delete-scope + reinsert ingest (dup-free by construction) gated by a **content-hash marker
`context_graph_hash`** (NOT git-HEAD), single-flight per DB, **fail-open**.

Four typed edges: `decision_touches_file`, `decision_cites_principle`, `supersedes` (structured ADR
frontmatter only — prose-only supersession is out of scope), `build_produced`. Two additive
`graph_query` types expose the traversal: `context_for_file` and `supersedes_chain`.

## Consequences

- **Positive:** decisions/ADRs become traversable in the same KG the code lives in; the code graph
  stays uncontaminated; the migration is additive and forward-only (existing v6 state untouched);
  ingest is idempotent; the fresh-marker fires on commit-less decision mutations.
- **Negative / trade-off:** a third node concept in the KG (beyond files/entities/doc-chunks) is more
  surface to maintain; the content-hash gate walks the decisions corpus + ADR dir on the first context
  query after a mutation (a bounded cost, mitigated by single-flight + the no-op fast path on an
  unchanged hash).
- **Fail-open is deliberate and in tension with Canon's fail-closed safety gates.** The context-graph
  freshness gate is a RETRIEVAL-QUALITY surface: a stale-but-served graph degrades retrieval, it never
  bypasses a safety control. This mirrors the already-shipped `ensureDocCorpusFresh` posture (ADR-0029)
  and is the opposite of `fail-closed-by-default`, which governs safety gates only.
- **Reversal cost:** high once shipped — downstream traversal consumers and the v7 schema become load-
  bearing; unwinding requires a schema migration and consumer changes. This is why the choice is
  recorded here rather than as an ephemeral workspace decision.
