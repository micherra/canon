# SpecStory + Karpathy LLM Wiki vs. Canon — Comparison

**Sources:**
1. SpecStory — https://specstory.com / https://github.com/specstoryai (landing page WebFetch returned 403; synthesized from WebSearch snippets and company description)
2. Karpathy's LLM Wiki gist — https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f (fetched verbatim from the HTML gist page on 2026-04-20)

**Date:** 2026-04-19 (Karpathy section rewritten 2026-04-20 against the primary-source gist)
**Purpose:** Catalog ideas from (a) SpecStory, a chat-capture + spec-driven-development tool for AI coding, and (b) Karpathy's "LLM Wiki" gist — an architectural pattern for LLM-maintained personal knowledge bases. Classify against Canon and surface adoption candidates.

---

## Source 1 — SpecStory

### What it is

SpecStory is a commercial tool (Jake/Sean/Greg, late 2024) that automatically **captures every AI chat** from Cursor, Copilot, Claude Code, and Codex, stores them locally, makes them searchable across tools, and syncs context across sessions and machines. The framing is "intent is the new source code" — transcripts of human↔AI dialogue are treated as a first-class artifact worth preserving, not ephemeral. SpecStory is adjacent to, but distinct from, spec-driven development as a methodology (which treats structured written specs as the primary artifact of development, with code as generated output).

### Idea inventory

| # | SpecStory idea | Classification | Canon equivalent / gap |
|---|---|---|---|
| 1 | Auto-capture every AI chat to local storage | **Partial overlap** | Canon records agent transcripts per state and exposes them via `get_transcript` (`canon-reference.md:93`). Coverage is scoped to agent spawns inside flows — not the orchestrator's own conversation or ad-hoc chats outside Canon. |
| 2 | Unified chat history across tools (Cursor, Copilot, Claude Code, Codex) | **Non-fit** | Canon is a Claude Code skill. Cross-tool chat aggregation is out of scope — Canon's orchestrator and agent transcripts are the substrate, not external IDE chats. |
| 3 | Search across all AI conversations | **Partial overlap** | `get_transcript` reads one state's transcript. No cross-workspace full-text search over historical chats exists. The `explore` flow and learner agent are the closest analogs, but they reason about code, not chat history. |
| 4 | "Intent as source code" — durable human intent artifact | **Duplicate in spirit** | Canon's `plans/`, `REVIEW.md`, progress.md, and scribe-synced `CLAUDE.md` files already encode intent durably. Canon goes further: intent is structured (principles + plans + artifacts) rather than raw chat log. |
| 5 | Context portable across machines / sessions | **Partial overlap** | Canon's `board.json` + `progress.md` resume covers in-workspace continuity (`CLAUDE.md` — "resume" intent). Cross-machine sync is not a Canon feature (local `.canon/` only). |
| 6 | Treat chat transcript as a shareable/reviewable artifact | **Novel** | Canon stores transcripts but exposes them only to agents. There is no "export this flow's transcript as a shareable record of decisions." Canon artifacts are plan/review/progress, not dialogue. |
| 7 | Spec-driven development (comprehensive spec before code) | **Partial overlap** | Canon's `feature` and `epic` flows produce a plan artifact before implementation (`canon-reference.md:38–40`). Canon's plans are lighter than SDD-style full specs; they focus on steps + verification, not comprehensive "what NOT to build" context. The roadmap **Item 28 (Idea-to-Spec Flow)** directly targets this gap. |
| 8 | Convert chats retroactively into specs/notebooks | **Novel** | Canon doesn't mine agent transcripts to synthesize new specs. The scribe syncs `CLAUDE.md` from diffs, not from chat history. |
| 9 | Privacy: local-first chat storage | **Duplicate** | Canon is local-first by construction (`.canon/`, SQLite, worktrees). No remote telemetry. |

---

## Source 2 — Karpathy's "LLM Wiki" gist

### What it is

Karpathy proposes a **persistent, LLM-maintained personal wiki** as an alternative to RAG over raw documents. Instead of re-retrieving fragments at every query, the LLM incrementally builds and maintains an interlinked markdown knowledge base — "compiled once and then *kept current*, not re-derived on every query" — sitting between the user and their curated sources. The architecture is three layers (immutable raw sources, LLM-owned wiki pages, a `CLAUDE.md`/`AGENTS.md` schema file) plus three operations (ingest, query, lint), with `index.md` (content catalog) and `log.md` (chronological append-only record) as navigation aids.

Key verbatim framings: "Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase." "The wiki is a persistent, compounding artifact." "The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the bookkeeping."

### Idea inventory

| # | Karpathy LLM Wiki idea | Classification | Canon equivalent / gap |
|---|---|---|---|
| 1 | LLM builds a persistent, interlinked wiki from sources (bypassing RAG) | **Partial overlap** | Canon maintains scribe-synced `CLAUDE.md` per directory and a structured knowledge graph of the codebase, but there is no general-purpose wiki-maintainer agent that ingests external sources (articles, papers, transcripts) into an LLM-owned page collection. Canon's artifacts are task-scoped (plans, reviews, progress), not an accreting knowledge corpus. |
| 2 | Three layers: immutable raw sources / LLM-owned wiki / schema file | **Partial overlap** | Canon has an analogous separation — source code (immutable-ish substrate), Canon-owned artifacts (`plans/`, `REVIEW.md`, drift), and `CLAUDE.md`/principles as the schema. But Canon's "wiki layer" is a set of task artifacts plus the KG; it is not a navigable cross-linked markdown corpus. |
| 3 | Three operations: ingest, query, lint | **Partial overlap** | Canon has ingest-shaped activity (scribe syncs `CLAUDE.md` from diffs; KG rebuilds from source) and lint-shaped activity (drift reports, `get_compliance`, reviewer). Query is `semantic_search`/`graph_query`. But ingest-from-external-sources is absent, and there is no scheduled "lint the wiki" pass — Canon's drift is compliance-of-code, not consistency-across-pages. |
| 4 | `index.md` (content catalog) + `log.md` (chronological append-only) as navigation | **Partial overlap** | Canon's `board.json` is a structured per-workspace state record and `progress.md` is a per-workspace chronological log. No repo-wide `index.md` catalog across workspaces; no append-only global `log.md` with a parseable `## [YYYY-MM-DD] type \| title` convention. agentkb's chronological chats store is closer to this than Canon is. |
| 5 | Schema file (`CLAUDE.md`/`AGENTS.md`) that encodes wiki conventions and workflows | **Duplicate** | Canon is built around CLAUDE.md-per-directory plus principle injection hooks (`hooks/principle-inject.sh`). The shape is exactly this, just specialized to code-governance rather than knowledge-base conventions. |
| 6 | "Good query answers can be filed back into the wiki as new pages" — explorations compound | **Novel** | Canon's `explore` flow produces a research brief but there is no standing convention for folding exploration outputs into a durable cross-queryable artifact. Results stay inside the workspace; they don't compound. |
| 7 | Wiki-lint pass: contradictions, stale claims, orphan pages, missing cross-references | **Partial overlap** | Canon's drift report and `get_compliance` lint code-vs-principles. There is no analogous lint over Canon's own artifacts (`CLAUDE.md`s contradicting each other; stale plans; principles without backing examples). |
| 8 | Git-backed markdown repo as the storage substrate | **Duplicate** | Canon's principles and artifacts are markdown in git; `.canon/` runtime is local. Same substrate. |
| 9 | LLM-generated wiki is *owned* by the LLM — human curates sources and asks questions | **Partial overlap** | Canon's scribe owns `CLAUDE.md` sync and agents own their artifacts, but the human is still the primary author of principles and plans in practice. Karpathy's stance ("You read it; the LLM writes it") is more extreme than Canon's current division. |
| 10 | Pattern is abstract / modular — copy the idea, your agent instantiates the specifics | **Non-fit** | Canon is a concrete harness with fixed state machines, hooks, and schemas. "Share the pattern, let the agent instantiate it" is orthogonal to Canon's shape, though Canon could *host* a wiki-maintainer flow as one more flow definition. |

### Overlap with agentkb

Karpathy's wiki architecture overlaps materially with **agentkb's four-store memory model** (see `docs/research/agentkb-pi-comparison.md`). Both treat an LLM-maintained markdown knowledge base as durable infrastructure between the user and raw inputs; both use plain markdown + git as the substrate; both rely on a chronological append-only log. The differences: agentkb partitions into four typed stores (Wiki / Chats / Communications / Skills) with per-store retrieval, while Karpathy's proposal is a single wiki with `index.md` as the retrieval primitive (and `qmd` as an optional hybrid search upgrade). agentkb's **consolidation workflow** (chats → wiki entries) is the operational analog of Karpathy's ingest + "file query answers back into the wiki" pattern. The adoption candidate below is deliberately scoped to pair with the consolidation workflow already called out in `agentkb-pi-comparison.md` Adoption #1, rather than duplicating it.

---

## Adoption Candidates

### 1. Append-only chronological log with parseable prefix (from Karpathy #4)

Canon has per-workspace `progress.md` but no global `log.md` that records ingests, flow completions, principle additions, and lint passes across the whole project in chronological order. Adopting Karpathy's `## [YYYY-MM-DD] type | title` prefix convention (grep-parseable in one line) and writing to a repo-level `.canon/log.md` would give the learner, the guide, and humans a single timeline of "what happened here" without scanning each workspace. Pairs directly with agentkb's chronological chats store framing (`agentkb-pi-comparison.md` Adoption #2).

**Fit:** Good. Additive; writes occur at flow transitions and principle events. Orchestrator untouched beyond a single append at `complete_flow`.

### 2. Wiki-lint pass over Canon's own artifacts (from Karpathy #7)

Canon lints code against principles but not its own artifacts against each other. A new lint pass — contradictions between `CLAUDE.md`s, orphan principles with no usages, stale plans referencing renamed files, principles without backing examples — would apply Karpathy's wiki-health operation to Canon's own meta-layer. Slots into the diagnostics bounded context alongside `get_drift_report`.

**Fit:** Good. Reuses the scribe and learner; surfaces via a new `get_artifact_drift` tool or an extension to `get_drift_report`.

### 3. Compounding exploration — file `explore` outputs into a durable artifact (from Karpathy #6)

Karpathy's "good query answers can be filed back into the wiki" insight maps cleanly onto Canon's `explore` flow: today the research brief lives inside the workspace and doesn't accrete anywhere. A convention (or a scribe step) that promotes notable `explore` findings into a project-level `docs/notes/` or equivalent — cross-referenced by topic — would make Canon's explorations compound over time instead of scattering. Overlaps with agentkb's consolidation workflow (`agentkb-pi-comparison.md` Adoption #1); implement the two together.

**Fit:** Good. Additive scribe responsibility; no orchestrator change.

### 4. Transcript-to-spec extractor (from SpecStory #8 + roadmap Item 28)

SpecStory's "chats as durable intent" collides cleanly with Canon roadmap **Item 28 (Idea-to-Spec Flow)**. Canon already records agent transcripts via `get_transcript`; what's missing is an extractor that mines a conversational `explore` or `chat` session and emits a structured spec artifact usable as input to `feature`/`epic`. This validates and sharpens Item 28 — the spec output format matters, and treating transcripts as the raw material is the right primitive.

**Fit:** Good. Reshapes Item 28 rather than adding new scope. Uses existing transcript storage; adds a new artifact template + a spec-synthesis agent role.

### 5. Cross-workspace transcript search (from SpecStory #3)

`get_transcript` reads one state's transcript. A cross-workspace full-text search over historical agent transcripts would let the learner find recurring patterns ("every time we touch the migration module, the researcher asks about X") and let humans retrieve "what did we decide about Y last month?" without re-reading plans. Complements roadmap **Item 20 (Workflow Pattern Mining)** — patterns are more findable with searchable transcripts than by scanning structured metrics alone.

**Fit:** Moderate. Requires a transcript index (SQLite FTS over the existing transcripts). Surfaces via a new MCP tool. Useful for the learner and the guide. Build cost moderate; value compounds over time.

---

## Explicit Non-Fits

| Idea | Why it conflicts |
|---|---|
| **Aggregate chats across IDEs (Cursor, Copilot, Codex, Claude Code)** | Canon lives inside Claude Code. Cross-tool aggregation is a SaaS shape incompatible with Canon's local-first, skill-scoped model. |
| **Cross-machine chat sync** | Canon state is `.canon/` + worktrees, local by design. Cloud sync would invert the threat model and add infrastructure Canon doesn't need. |
| **"One `CLAUDE.md` file, copy-paste it and go"** | Canon's value is structured principles + state machine + hooks + drift tracking. A flat file cannot host severity levels, drift, compliance trends, or matcher rules. Canon can *consume* such a file as a per-directory CLAUDE.md — but that's already supported. |
| **Treating full raw chat transcripts as the primary artifact** | Canon's artifacts are structured (plans, reviews, progress, principles). Raw dialogue is secondary data; structured extractions (spec, decision record, principle candidate) are what agents and humans actually consume. The Item 28 reshape above uses transcripts as *input* to synthesis — not as the output. |
| **Public chat-as-social-artifact sharing** | SpecStory frames transcripts as shareable public artifacts. Canon's transcripts can leak credentials, internal code, and decisions not meant for external consumption; no public-sharing affordance is appropriate. |
| **Spec-Driven Development as the only entry point** | Canon's flow library deliberately spans the size spectrum (fast-path → epic). Forcing a comprehensive upfront spec on every task would regress the fast-path's whole reason for existing. Item 28 adds SDD as an *option* for the "I don't know what I want" case, not as a default. |
| **Karpathy's wiki as a replacement for Canon's principle/KG layer** | Karpathy's wiki is an evolving free-form knowledge corpus owned by the LLM; Canon's principles are prescriptive, drift-tracked, and compliance-scored. Swapping in a generic wiki store would lose severity levels, the compliance machinery, and the reviewer's enforcement surface. A wiki-maintainer *flow* is additive; a wiki-as-substrate is not. |
| **"LLM writes everything, human only curates sources"** | Karpathy's extreme authorship split fits a personal knowledge base where style and taste are local. Canon's principles are shared team infrastructure — humans must author them to retain accountability for what the agents enforce. Automated principle authoring is a `canon-writer` *draft* step, not an ownership shift. |
| **Obsidian as the primary reading surface** | Canon's reading surfaces are Claude Code, MCP apps, and the repo file tree. Depending on Obsidian would add a second tool to the loop without replacing anything Canon already ships. |

---

## Summary of the Fit Assessment

**SpecStory** and Canon agree on "intent is durable," but SpecStory builds it around raw chat capture across IDEs while Canon builds it around structured artifacts (plans, principles, drift, scribe-synced `CLAUDE.md`s). The productive overlap is exactly the Idea-to-Spec flow (roadmap Item 28) — SpecStory validates that taking conversation seriously as input to specs is worth doing, and suggests the transcript as the right raw material. Cross-tool aggregation and public chat sharing are non-fits.

**Karpathy's LLM Wiki** is an architectural pattern for LLM-maintained personal knowledge bases — explicitly framed as an alternative to RAG-over-raw-documents. It overlaps substantially with agentkb's four-store memory model (chronological log, markdown substrate, LLM-owned consolidation); the two should be read together. Three ideas transfer cleanly: (a) a **repo-level `log.md`** with Karpathy's parseable `## [date] type | title` convention as a single project timeline; (b) a **wiki-lint pass** applied to Canon's own artifacts (contradictions between CLAUDE.md's, orphan principles, stale plans) mirroring `get_drift_report` at the meta-layer; and (c) **compounding explorations** — promoting notable `explore` outputs into a durable cross-referenced corpus instead of letting them die in the workspace. Karpathy's wiki as a *substrate replacement* for principles is a non-fit; his `CLAUDE.md`-as-schema framing is already how Canon works.

Everything else is either already covered (markdown + git substrate, CLAUDE.md schema, local-first) or architecturally incompatible (LLM as sole author, Obsidian as the reading surface, cross-IDE SaaS, one-file harness).
