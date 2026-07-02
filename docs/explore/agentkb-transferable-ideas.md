# AgentKB → Canon: Transferable-Ideas Investigation

**Date:** 2026-06-29
**Source:** Isaac Flath, "AgentKB" — https://isaacflath.com/writing/agentkb
**Type:** Exploration / design-altitude analysis. No code, no workspace.
**Author audience:** Canon author (you).

---

## 1. AgentKB in one paragraph

AgentKB is a durable, searchable memory layer for amnesiac coding agents. It stores **four
independently-searchable markdown corpora**: (1) **agent chats** auto-ingested from Claude Code
/ Pi sessions (user msgs, assistant replies, tool calls + results), (2) **X posts** pulled and
rendered to markdown, (3) a **wiki** of *manually* synthesized lessons / preferences / gotchas /
taste, and (4) **thin procedural skills**. Its headline lesson is a split discovered the hard way:
fat skills accumulated "preferences, corrections, and lessons from things the agent did wrong all
stacked into the same files," forcing agents to read irrelevant content — so skills were forced to
stay *procedural business logic* while all the gotchas/taste/opinions moved into the searchable
wiki. Retrieval is **late-interaction multi-vector (ColBERT/PLAID)** — one vector *per token*, so
each query token matches its best document token and scores sum per-token; PLAID centroid
quantization keeps it incrementally indexable as the corpus grows. Ingestion is automated;
**synthesis into the wiki is manual** (consolidation prompts that fold recent chats/posts into wiki
updates, plus ad-hoc "add this to the wiki" requests). Every search writes a **trace to local
SQLite** (query, per-stage rankings, final top-k) for retrieval eval. Privacy is a **trust tier**:
private text messages are deliberately excluded despite their signal, on consent grounds.

---

## 2. Idea inventory

| # | Idea | AgentKB mechanism | Canon's current analogue (file/tool) | Verdict | Maps to in-flight / roadmap |
|---|------|-------------------|--------------------------------------|---------|------------------------------|
| A | **Thin-procedure / searchable-knowledge split** | Skills = procedural only; gotchas/taste/rationale live in retrievable wiki | `CLAUDE.md` (713 lines) mixes both: orchestration spine + 18 inline distilled-learning citations + 13 parenthetical `(watch_/dc-/ADR-)` rationale nuggets. `principles/` is the distilled layer but is loaded structurally, not retrieved by relevance | **Gap (partial)** | `reduce-root-claudemd-size` (in-flight), `watch_FFFFF2` doc-budget cycle (2/2 threshold) |
| B | **Auto-ingested raw chat corpus, semantically searchable** | Chat history auto-captured → markdown → late-interaction index | 232 `build-digest-*.md` + watch-history + `transcripts/` exist but are **not** vector-indexed. `semantic_search` indexes only code entities + file summaries (`kg-vector-store.ts`) | **Gap** | None direct; adjacent to MP-2/MP-3 backlog + learner inputs |
| C | **Manual wiki synthesis (consolidation prompts)** | Human-in-loop prompts fold chats/posts → wiki | `canon:learner` + trace-driven-evolution stack (`select_mutation_targets` → Mutator → `evaluate_candidate` §7 holdout → `evolve` loop → `.canon/proposed-learnings/`) | **Canon-ahead (redundant)** | trace-driven-evolution Phase 1 (shipped #413/#414/#418/#421/#423) |
| D | **Late-interaction (ColBERT/PLAID) retrieval** | One vector per token; per-token max-sim scoring; PLAID quantization | `semantic_search` = `all-MiniLM-L6-v2`, 384-dim, **one vector per document** (sentence-level), sqlite-vec KNN (`kg-embedding.ts`, `kg-vector-query.ts`) | **Gap (low-leverage)** | None |
| E | **Search-trace logging to SQLite for retrieval eval** | Every search logs query + per-stage rankings + top-k | No retrieval-eval logging. Canon logs *build* traces (`orchestration.db`, drift.db) but not search/retrieval quality | **Net-new (small)** | Adjacent to evolution eval infra |
| F | **Trust-tiering of ingested content** | Private texts excluded; consent-gated lower trust tier | `overlay-inert-data-hardening` (QUEUED: neutralize→fence→trust-tier), Phase-0 context hardening PR #420, `kg-language-overlay.ts` fail-open loader | **Canon-ahead (reinforces)** | overlay-inert-data-hardening (queued), posthog/context-mill Phase 0 |
| G | **Plain-markdown, human-maintainable corpora** | All four stores are markdown dirs — agent-readable, chunkable, hand-editable | Canon is markdown-native already: `principles/`, `references/`, `CONTEXT.md`, `.canon/proposed-learnings/`, digests | **Canon-ahead (redundant)** | — |
| H | **Multiple independently-searchable stores (corpus separation)** | 4 stores searched independently, not one blob | Canon has *layers* (principles/rules/conventions, references, digests) but one structural matcher + one code-only vector index — not independent semantic corpora | **Gap (design)** | Adjacent to A + B |
| I | **Skills reference the wiki (pointer, not inline)** | Skill body points to wiki entries for taste/inspiration | Canon agents `Read references/X BEFORE doing Y` (pointer pattern already used in CLAUDE.md HITL/DAG sections) | **Canon-ahead (partial)** | reinforces A |

---

## 3. Deep dive — top 3 highest-leverage ideas

### 3.1 (A) Thin-procedure / searchable-knowledge split — the prime candidate

This is the sharpest transfer because Canon is living the exact failure AgentKB describes, and there
is already an in-flight build (`reduce-root-claudemd-size`) plus a learner watch at promotion
threshold (`watch_FFFFF2`, doc-budget growth cycle, 2/2) pointed at the symptom.

**Grounded categorization of root `CLAUDE.md` (713 lines):**
- 44 section headings, 99 markdown table rows → the file is dominated by **procedure**: the
  orchestration sequence (intent classification, Pre-Build Gate, trivial/non-trivial paths, DAG
  protocol, journal protocol, completion checklist, error handling). This is genuinely procedural
  "business logic an agent must follow" — the analogue of an AgentKB *skill*.
- **18 lines** cite a distilled-learning ID (`watch_*`, `sug_*`, `convention_*`, `ADR-*`, `dc-0*`);
  **13** are inline parenthetical rationale `(watch_…/dc-…/ADR-…)`. These are **knowledge**, not
  procedure: e.g. "Conversations exceeding ~100 messages trigger Claude Code cache_control TTL
  ordering bugs"; the `watch_CCCCCCCCCCCC1` adversarial-framing rationale; `watch_NNNNN2` stream-idle
  recovery; `watch_YYYY1`/`watch_ZZZZ2` push/merge gotchas; the Hook-bypass-fix `watch_UUUUUUUU2`
  posture note. Each is a gotcha/taste/rationale nugget stacked into the procedural file — **exactly
  AgentKB's fat-skill antipattern**.

**The genuinely transferable delta:** AgentKB's move is *don't shrink the knowledge — relocate it*.
The gotchas don't get deleted; they move to a store retrieved **on relevance** so the procedural
spine stays lean and every agent isn't forced to read all of it every spawn. Canon's reflex (and the
`reduce-root-claudemd-size` framing) is **compression** — tighten prose, cut lines. That treats a
*relocation* problem as a *budget* problem, which is why `watch_FFFFF2` keeps recurring (the budget
refills because new gotchas have nowhere else to go).

**Where Canon already covers it:** Canon *has* the relocation target — `principles/` (64) +
`.canon/principles/` (35, `portable:false`) + `references/` (20 protocol fragments) + `CONTEXT.md`
(113-line glossary). The pointer pattern exists too ("Read `references/hitl-patterns.md` BEFORE
presenting any HITL checkpoint"). So idea (I) is already in use.

**The concrete gap:** the relocation target is retrieved **structurally**, not **semantically**.
`principles/` is matched by `shared/matcher.ts` on `scope.layers` OR `scope.tags` intersection — and
`references/` fragments are loaded by **hard-coded pointer** ("Read X BEFORE Y"), not by relevance to
the live task. So unlike AgentKB, Canon cannot say "given this orchestration moment, surface the 3
most relevant gotchas." The inline `(watch_…)` nuggets stay inline *because* there is no
relevance-retrieval path that would surface them at the right moment if they were moved out.

**Verdict:** **Reinforces and redirects** `reduce-root-claudemd-size`. The redirect: reframe the
build's success metric from "fewer lines" to "procedure-spine vs relocatable-knowledge separation,"
and feed `watch_FFFFF2` the structural insight (budget refills because relocation has no
relevance-retrieval path — see 3.2). Lowest-cost first step: tag every inline `(watch_…)` nugget in
CLAUDE.md as a relocation candidate and route it to a `references/` gotcha fragment, accepting that
retrieval stays pointer-based for now.

### 3.2 (B+D) Make the raw + distilled corpora semantically searchable

AgentKB's load-bearing capability is that **the raw chat corpus is auto-ingested and
semantically retrievable** — the wiki is the curated cream, but the chat index is the safety net you
fall back to when the wiki hasn't distilled something yet.

**Grounded state of Canon's retrieval:** `semantic_search` → `all-MiniLM-L6-v2` (384-dim),
**document-level** embeddings (one vector per item), KNN over **two tables only**: `entity_vectors`
(code symbols) and `summary_vectors` (file summaries) (`kg-schema.ts`, `kg-vector-store.ts`). It does
**not** index the 232 build digests, the watch-history accumulation, `principles/` prose,
`references/`, `.canon/proposed-learnings/`, or captured `transcripts/`. Canon's entire
**experiential** memory — the layer AgentKB auto-ingests — is invisible to semantic retrieval.
The learner reaches it by `grep` / `get_cross_run_analysis` (structural), not by relevance.

**The transferable delta (high-leverage, idea B):** point the *existing* embedding pipeline at the
markdown corpora. Canon already ships the embedding service, sqlite-vec, freshness plumbing
(`ensureGraphFresh`), and a vector schema. Adding a `doc_vectors` table fed from
digests/principles/references is an incremental extension of working infrastructure, not new infra.
This would give the learner (and the orchestrator at HITL time) "find the 5 most relevant prior
build gotchas to *this* situation" — which is precisely the retrieval that idea (A) needs to finally
relocate CLAUDE.md's inline nuggets without losing them.

**The low-leverage part (idea D — explicit caution):** the *late-interaction/ColBERT/PLAID* upgrade
is **not** worth it for Canon. AgentKB needs token-level matching across long heterogeneous prose
(papers, X threads, repos). Canon's corpora are short, structured, ID-tagged markdown. Document-level
MiniLM is already adequate; the delta from per-token vectors would be marginal recall against a
multiplicative storage + indexing cost (400 vectors per 400-token passage) and a new dependency
surface. **Take B's "index the markdown corpus"; decline D's "make it late-interaction."**

**Verdict:** **Net-new build** (`semantic-index-the-knowledge-corpus`), but it is the keystone that
unblocks 3.1. Touches `mcp-server/src/features/knowledge-graph/` (vector store + a doc-ingestion
pass), `kg-schema.ts` (new `doc_vectors` table), and the learner's retrieval path. Caution flag:
embedding 232+ digests is cheap, but a re-index trigger and staleness story must be designed
(reuse `ensureGraphFresh` semantics).

### 3.3 (C) Automated synthesis — where Canon is *ahead*, and the honest comparison

AgentKB's wiki synthesis is **manual**: "AgentKB has prompts that synthesize recent chats and X posts
into wiki updates," plus ad-hoc human "add this to the wiki." A human runs the consolidation.

**Canon's analogue is automated and gated.** The learner + trace-driven-evolution stack is a
closed loop AgentKB does not have:
- `context_provenance` instrumentation records what context each agent saw (#413).
- `attribute_failure` joins provenance ⋈ review-violations/cliff-events to localize a failure to the
  in-context artifact that likely caused it (#418, ADR-0024).
- `select_mutation_targets` deterministically picks `hash_verified` + `confidence:high` +
  `gate_eligible` targets (#421).
- the Mutator rewrites the guardrail; `evaluate_candidate` runs a **§7 strict-holdout** fitness gate
  before any candidate is accepted (#414, #421, ADR-0022/0025).
- the `evolve` loop surfaces `run-evolve`; accepted candidates land in `.canon/proposed-learnings/`
  **HITL-gated regardless of tier** (#423).

So Canon already does *automated, evaluated, attribution-driven* distillation. AgentKB's manual
consolidation prompt is, for Canon, a **regression** — adopting it would replace a holdout-gated
evolutionary loop with an ungated human transcribe step.

**The honest caveat:** AgentKB's manual synthesis still beats Canon on one axis — **coverage**.
Canon's loop only distills what its attribution pipeline can localize to a failure (review
violations, cliff events). AgentKB's human can fold in *positive* signal — "this approach was
elegant, capture the taste" — which Canon's failure-attribution-driven loop structurally cannot see.
Canon distills from what went *wrong*; AgentKB's human also distills from what went *right*. That is
a real, narrow gap (see Recommended thread R4).

**Verdict:** **Canon-ahead / redundant** on the mechanism; **do not adopt** manual synthesis. Note
the positive-signal coverage gap as a distinct, smaller thread.

---

## 4. Explicit non-transfers (what Canon should NOT adopt)

1. **Manual wiki consolidation prompts (idea C).** Regression vs Canon's automated, holdout-gated
   learner/evolution loop. Adopting a human transcribe-into-wiki step would *lower* the bar Canon
   already clears. (Caveat: the *positive-signal coverage* sub-gap is worth a small separate thread —
   R4 — but the manual *mechanism* is not.)
2. **Late-interaction ColBERT/PLAID retrieval (idea D).** Infra cost (per-token vectors, PLAID
   centroid store, new dependency) ≫ payoff for Canon's short, structured, ID-tagged markdown.
   Document-level MiniLM already in place is sufficient. Take "index the corpus" (B), leave the
   "make it token-level" upgrade.
3. **X-post ingestion as a first-class store.** AgentKB indexes the author's X feed as a knowledge
   source. Canon's knowledge provenance is the build history + principles + the team's decisions —
   an external social feed has no clean trust story here and collides head-on with the
   `overlay-inert-data-hardening` posture (untrusted external text must be neutralized/fenced, not
   indexed as authority). Decline.
4. **Four-store taxonomy as-is.** AgentKB's four stores (chats/X/wiki/skills) are *its* corpus mix.
   Canon's natural corpora are different (build digests / principles+references / proposed-learnings
   / CLAUDE.md+agents). Borrow the *separation principle* (idea H), not the literal four categories.

---

## 5. Recommended threads (ranked)

| Rank | Thread | Tag | Canon artifact(s) it touches |
|------|--------|-----|------------------------------|
| **R1** | **Reframe `reduce-root-claudemd-size` as procedure-vs-knowledge *relocation*, not line-count compression.** Tag CLAUDE.md's inline `(watch_…)` / rationale nuggets as relocation candidates; route them to `references/` gotcha fragments via the existing pointer pattern. Feed `watch_FFFFF2` the structural finding (budget refills because relocation lacks a relevance-retrieval path). | **Fold into existing in-flight build** | `CLAUDE.md`, `references/*.md`, `watch_FFFFF2` learner item |
| **R2** | **`semantic-index-the-knowledge-corpus`** — extend the existing MiniLM/sqlite-vec pipeline with a `doc_vectors` table fed from build digests, principles, references, and proposed-learnings, so the learner + orchestrator can retrieve prior gotchas by relevance. This is the keystone that lets R1 relocate knowledge without losing it. Decline the ColBERT upgrade. | **Net-new build** | `mcp-server/src/features/knowledge-graph/` (vector store, doc-ingest pass), `kg-schema.ts`, learner retrieval path |
| **R3** | **Confirm `overlay-inert-data-hardening` already encodes AgentKB's trust-tier instinct** — and explicitly add an *ingestion trust tier* to R2's design so any future external/overlay corpus is fenced before it can be retrieved as authority. | **Fold into queued build** | `overlay-inert-data-hardening` (queued), `kg-language-overlay.ts`, Phase-0 context hardening |
| **R4** | **Positive-signal distillation gap** — Canon's evolution loop only learns from failures (review violations / cliff events). AgentKB's human can also capture "what went *right*." Explore whether the learner can mine *successful* build digests for transferable taste, not just failure attribution. | **Explore-further** | `canon:learner`, `get_cross_run_analysis`, evolution attribution inputs |
| **R5** | **Retrieval-eval trace logging** — once R2 exists, log search query + rankings + top-k to drift.db to measure retrieval quality (AgentKB's SQLite search-trace idea). Small, only meaningful after R2. | **Explore-further (defer)** | `semantic_search` handler, drift.db |
| — | X-post ingestion; ColBERT/PLAID; manual wiki synthesis | **Decline** | — (see §4) |

---

## Assumptions (per agent-surface-assumptions)

- **`semantic_search` indexes only code entities + file summaries** — *confidence: high*. Verified
  in `kg-vector-query.ts` (queries `entity_vectors` + `summary_vectors` only), `kg-schema.ts` (only
  those two vector tables), and absence of any digest/principle/markdown ingestion grep hit in
  `features/knowledge-graph/`.
- **Principles are retrieved structurally (layer/tag), not semantically** — *confidence: high*.
  `shared/matcher.ts` matches on `scope.layers`/`scope.tags`; no `EmbeddingService` import under
  `features/principles/`.
- **`reduce-root-claudemd-size` is framed as compression, and `watch_FFFFF2` is at 2/2** —
  *confidence: medium*. From the orchestrator memory index + build digests, not from reading the
  build's PRD directly (no active workspace inspected). The relocation-vs-compression reframe in R1
  assumes the build has not already adopted a relocation framing.
- **AgentKB's wiki synthesis is fully manual** — *confidence: medium*. From the essay's own wording
  ("AgentKB has prompts that synthesize…" + ad-hoc human adds); the essay does not describe an
  automated trigger, but absence of mention is not proof of absence.
- **Embedding 232 digests is cheap enough to be incremental** — *confidence: medium*. Based on
  corpus size + the existing batch-embedding service; not load-tested.
