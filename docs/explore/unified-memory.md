# Unified Agent Memory vs. the Field: Cognee, Zep, Mem0, Letta

**Date:** 2026-07-11
**Source:** "Cognee vs Zep vs Mem0 vs Letta" — https://theaiengineer.substack.com/p/cognee-vs-zep-vs-mem0-vs-letta
**Type:** Exploration / synthesis. Compares Canon's shipped Unified Agent Memory epic against an
external survey of the four leading agent-memory frameworks. This is a synthesis of the article's
architecture deep-dives, not a design spec — no code, no workspace.
**Author audience:** Canon author (you).

---

## 1. Canon's Unified Agent Memory epic — current state (SHIPPED)

- **M1 — `recall`** (PR #478, released v2.20.0): fused retrieval MCP tool, reciprocal-rank fusion
  (RRF) over 5 stores.
- **M2 — context graph** (PR #487, ADR-0047): decisions/ADRs/builds promoted into the KG as a
  traversable graph. Schema v7 adds `context_nodes` (`record_kind`: `decision` | `adr` | `build`)
  and `context_edges` (`decision_touches_file` | `decision_cites_principle` | `supersedes` |
  `build_produced`). Two new `graph_query` types: `context_for_file` and `supersedes_chain`. Epic
  complete = retrieval (`recall`) + traversal (context graph).
- **`search_knowledge`** (PR #435, AgentKB R2): semantic doc-vector index over the knowledge corpus
  — principles, references, agents, primers, build digests. Schema v6 (`doc_chunks`/`doc_vectors`).
- **Decisions-ledger durability** (PR #456, ADR-0040): `get_decisions_corpus` is an offline
  cross-workspace reader/aggregator, unioning live workspaces with a durable `orchestrator_decisions`
  table in `drift.db` so decisions survive workspace reap. Offline + deterministic per
  `docs/supervised-build-quality.md:216`.
- **Trace-driven evolution loop** (the self-improving half): `context_provenance` instrumentation
  (#413) → `attribute_failure` joins provenance ⋈ review-violations/cliff-events (#418, ADR-0024) →
  `select_mutation_targets` deterministic target selection (#421) → `evaluate_candidate` §7
  strict-holdout fitness gate (#414, ADR-0022/0025) → the `evolve` loop host (#423). Agent-def-body
  provenance closed the `applying_commit` seam (Inc-3, #484). Promotion into
  `.canon/proposed-learnings/` is human-gated via `/canon:review-learnings` regardless of tier.

The headline shape: Canon already has a **provenance-carrying, supersession-aware knowledge graph**
feeding a **holdout-gated evolutionary loop**, with an **offline, deterministic** posture throughout.
That shape is exactly what the four frameworks below are converging toward from different starting
points.

---

## 2. The four frameworks, one paragraph each

**Mem0** — lightweight memory middleware. An LLM extracts atomic facts from a conversation turn,
then a second LLM call reconciles each candidate fact against the top-k most similar existing
memories and emits one of ADD / UPDATE / DELETE / NOOP. Storage is a flat vector store scoped by
user/agent/run — no graph structure. Transferable idea: **reconcile-on-write** — new facts are
checked against what's already stored before being appended, not just appended blindly. Weakness:
the reconcile step is a single LLM judgment with no provenance or rollback, so a wrong UPDATE or
DELETE silently corrupts memory with no trail back to what caused it.

**Zep/Graphiti** — a bi-temporal knowledge graph. Every fact carries two independent time axes:
**valid-time** (`valid_at`/`invalid_at` — when the fact was true in the world) and
**transaction-time** (`created_at`/`expired_at` — when the system learned it). A contradiction is
handled as an **invalidation, not a deletion**: the old edge's `valid_until` is set to the new fact's
`valid_from`, so the superseded fact stays in the graph and remains queryable for point-in-time
questions ("what did we believe was true as of date X?"). Ingestion costs ~4–5 sequential LLM calls
per episode; retrieval is LLM-free — a hybrid of cosine similarity, BM25, and graph BFS. Transferable
idea: **bi-temporal validity windows + invalidate-don't-delete**.

**Cognee** — a self-improving graph via edge re-weighting. Every answer the system produces is
linked back to the triplets that generated it via a `used_graph_element_to_answer` provenance edge.
User reactions to that answer map to a −5…+5 sentiment score, which is attributed back along the
edge; an edge's weight is the additive sum of all feedback it has ever received. The graph never
deletes — bad paths just accumulate low weight and become visible (but not invisible) over time. The
fatal flaw: the aggregation is **quality-blind** — a careful, well-reasoned correction and a careless
downvote move the edge's weight identically. No source-trust weighting, no decay, no disambiguation
between "this was wrong" and "I didn't like the phrasing." Transferable idea: **provenance-edge
outcome attribution** — but only if done with the trust-weighting Cognee lacks and Canon already has.

**Letta/MemGPT** — LLM-as-operating-system paging. **Core memory** lives in-context and is
self-edited by the model via tool calls; **archival/recall memory** lives externally and is paged in
on demand. A memory-pressure threshold triggers eviction from core to archival when the context
budget is exceeded. Memory is structured as `{label, description, value, limit}` blocks, and blocks
can be **shared and attachable** — one live object multiple agents read and write to for handoff.
Every edit is a model round-trip (there is no mechanical write path). Transferable idea: **shared
append-only blocks for agent handoff**, plus **mechanical memory-pressure paging** as an eviction
policy, not a behavioral norm.

---

## 3. Alignment table

| Framework lesson | Canon thread it lands in | Status |
|---|---|---|
| Zep bi-temporal graph (valid-time + transaction-time, invalidate-don't-delete) | M2 context graph (#487, ADR-0047) — `supersedes` edges exist, but as a single-timestamp chain, not a dual-axis validity window | **Confirms-direction, with a gap** → Gap 1 |
| Cognee provenance-edge self-improvement loop | Trace-driven evolution (provenance → attribution → holdout gate → evolve loop, shipped and self-driving) | **Confirms-direction** — Canon already built the *correct* version: the §7 holdout gate and trust asymmetry (adversarial > author, external Codex > internal review, jury > single juror) is precisely the fix for Cognee's quality-blind additive sum → Gap 3 |
| Mem0 reconcile-on-write retrieval/write cycle | `recall` (#478) + `search_knowledge` (#435) cover the read side; there is no reconcile step on the write side — the learner and MEMORY-style notes are append-only | **Shipped (read); Genuine-gap (write)** → Gap 2 |
| Letta shared, attachable memory blocks | Event-backbone chatter (`post_message`/`tail_messages`, #450/#491) | **Shipped but ~zero organic use** — Letta's framing suggests the right primitive is a shared append-only *block* agents read/write, not a message bus agents must actively poll |
| Letta mechanical memory-pressure paging | Rehydration protocol + `checkpoint.md` + eve measured-step runtime (#473) | **Behavioral honor-system, not mechanical** — Letta encodes eviction as a rule, not a convention agents are trusted to follow |
| Article thesis: measure the write path, not just reads; the "accuracy paradox" (full-context often beats every memory tool) | eve (#473) measures the write/runtime path; MP-5 efficiency index still blocked | Compaction/rehydration is an explicit accuracy-for-cost trade Canon already names as a trade, not a free lunch |

**Headline finding:** 3 of the 4 frameworks (Zep, Cognee, Mem0) are converging on the same
architecture Canon's Unified Agent Memory epic and evolution program already built —
provenance-carrying, supersession-aware graph memory with gated promotion, kept offline and
deterministic. The article is external corroboration that Canon picked the right shape, not a signal
to change direction. The concrete value is in the deltas below.

---

## 4. Three next-increment gaps

### Gap 1 — Make M2's `supersedes` edges bi-temporal (Zep)

The context graph tracks supersession as a chain (`supersedes_chain` graph_query), but each edge
carries one timestamp, not the valid-time/transaction-time pair Zep uses. Adding the dual axis is a
precise cure for the prompt-version-decay problem — "weight a defect against the rule-set that was
*actually live* when the build ran" is currently archaeology (grep commit history, cross-reference
dates); with valid-time/transaction-time on `context_edges`, it becomes a filter (`valid_at <=
build_time < invalid_at`). This is a clean increment on top of the already-shipped M2 schema and
ADR-0047 — no new table class, just two additional timestamp columns and the invalidate-don't-delete
write path Zep uses for contradictions.

### Gap 2 — Reconcile-on-write for the learner / MEMORY-style notes (Mem0)

The learner is currently open-loop and append-only, which shows up as instance-counting churn in the
auto-memory watch entries (the same watch getting re-recorded rather than updated). Mem0's
ADD/UPDATE/DELETE/NOOP reconcile step is the right shape, but adopted with Canon's own constraints
applied on top: **soft-invalidate, never hard-delete**, and every reconcile decision carries
provenance back to what triggered it. That is consistent with Canon's existing fail-closed posture
(`fail-closed-by-default`) and the scribe's scope discipline (`hooks/scribe-scope-guard.sh` — a
scribe may only delete lines it added or demonstrably-stale references to artifacts it deleted). Do
not adopt Mem0's silent-UPDATE/DELETE behavior wholesale; adopt the reconcile *check*, not the
unaudited *mutation*.

### Gap 3 — Trust-weighted attribution consumer over the decisions ledger (Cognee, done right) — HIGHEST LEVERAGE

This is already the named next build on the AgenticSTS thread: a "proxy-reward/attribution consumer
over `get_decisions_corpus`," constrained to stay offline and deterministic per the
`docs/supervised-build-quality.md:216` rejection of online reward loops (the same line ADR-0040 cites
for `get_decisions_corpus`'s own durability constraint). Cognee supplies the mechanism worth
borrowing: a signed outcome weight attributed along a provenance edge back to the principle or rule
that fired. Cognee's flaw — additive-sum aggregation with no source-trust weighting — is exactly what
Canon's existing infrastructure already corrects for: the `evaluate_candidate` §7 holdout gate and the
trust asymmetry baked into Canon's review posture (adversarial re-review outranks the author's
self-assessment, an external Codex catch outranks an internal CLEAN verdict, a diverse-lens jury
outranks a single reviewer — see the security-intent adversarial-reverify mandate and
`references/team-dispatch-protocol.md`'s vertical jury mode). The substrate for this build already
exists and is shipped: `get_decisions_corpus`, `attribute_failure`, `evaluate_candidate`, and the
diverse-lens jury dispatch mode. This is a wiring/composition build over existing tools, not new
infrastructure — which is why it is the highest-leverage of the three gaps.

---

## 5. Cross-references

- [`docs/adr/0047-decisions-adrs-as-separate-kg-context-tables.md`](../adr/0047-decisions-adrs-as-separate-kg-context-tables.md)
  — M2 context graph schema (`context_nodes`/`context_edges`, `record_kind` subtype), the basis for
  Gap 1.
- [`docs/adr/0040-durable-decisions-corpus-via-reap-time-persistence.md`](../adr/0040-durable-decisions-corpus-via-reap-time-persistence.md)
  — durable `orchestrator_decisions` table and the offline+deterministic constraint (`:216`) that any
  Gap 3 work must preserve.
- [`agentkb-transferable-ideas.md`](agentkb-transferable-ideas.md) — the prior transferable-ideas
  synthesis (AgentKB); shares this doc's method (external framework → idea inventory → verdict →
  ranked threads) and reaches a parallel conclusion in its §3.3: Canon's automated, holdout-gated
  learner/evolution loop is *ahead* of the external tool's manual/ungated equivalent. The Cognee
  comparison here (§3, §4 Gap 3) reinforces that finding from a second, independent framework.
- `docs/supervised-build-quality.md:216` — the standing rejection of online/multi-session reward
  loops ("needs multi-session reward loops; reintroduces non-determinism"). Any implementation of
  Gap 3 must stay on the offline, deterministic side of this line — score from durable ledger data at
  build-finalize or learner-analysis time, never from a live in-session feedback signal.

---

## Assumptions (per agent-surface-assumptions)

- **PR numbers, ADR numbers, and tool names in §1 and the alignment table** — *confidence: high* for
  ADR-0047 and ADR-0040 (both verified present at `docs/adr/` and matching their cited content) and
  for `get_decisions_corpus`, `graph_query`'s `context_for_file`/`supersedes_chain` types (verified
  present in `mcp-server/src/features/knowledge-graph/tools/graph-query.ts` and
  `mcp-server/src/features/orchestration/tools/get-decisions-corpus.ts`). PR numbers themselves
  (#478, #487, #435, #456, #413/#414/#418/#421/#423, #484) are taken from durable project memory, not
  re-verified against GitHub in this build.
- **`docs/supervised-build-quality.md:216` as the online-reward-loop rejection boundary** —
  *confidence: high*. Read directly; the line rejects "ruflo's Thompson-sampling/Q-learning bandit
  half (needs multi-session reward loops; reintroduces non-determinism)," and ADR-0040 independently
  cites the same line number for the same constraint.
- **The four framework descriptions (Mem0, Zep/Graphiti, Cognee, Letta/MemGPT)** — *confidence:
  medium*. Synthesized from the source article's deep-dives as supplied for this build, not
  independently re-verified against each framework's own documentation or source code.
