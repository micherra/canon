# SpecStory + Karpathy Rant vs. Canon — Comparison

**Sources:**
1. SpecStory — https://specstory.com / https://github.com/specstoryai (landing page WebFetch returned 403; synthesized from WebSearch snippets and company description)
2. Karpathy tweet — https://x.com/karpathy/status/2039805659525644595 (WebFetch 403, as expected for X). Content reconstructed from news/blog mirrors surfaced via WebSearch; actual tweet text not verified verbatim.

**Date:** 2026-04-19
**Purpose:** Catalog ideas from (a) SpecStory, a chat-capture + spec-driven-development tool for AI coding, and (b) Karpathy's "AI coding rant" distilled by Forrest Chang into a `CLAUDE.md`. Classify against Canon and surface adoption candidates.

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

## Source 2 — Karpathy's AI coding rant → CLAUDE.md

### What it is

A short observational tweet from Karpathy listing recurring failure modes of LLM coding agents. Forrest Chang distilled it into a reusable `CLAUDE.md` ("andrej-karpathy-skills") that encodes four behavioral principles. The reconstructed failure modes (from mirror articles, not verified verbatim from the tweet):

- **Wrong assumptions without checking** — agents infer instead of reading the code/docs
- **Over-complication** — agents add speculative abstractions and features
- **Drive-by edits to unrelated code** — side-effect changes outside the task scope
- (A fourth behavioral principle is cited in coverage but not clearly named; likely about not fabricating APIs/ensuring grounding)

### Idea inventory

| # | Karpathy / Chang CLAUDE.md idea | Classification | Canon equivalent / gap |
|---|---|---|---|
| 1 | Don't make assumptions — check the code/docs first | **Duplicate** | Canon's researcher runs before implementor in every medium+ flow; principle severity `rule` can enforce "no unverified claims"; file-context and KG injection ensure the implementor has ground truth. Orientation calls are metricized (`roadmap.md:10`). |
| 2 | Don't over-complicate / no speculative abstractions | **Partial overlap** | This is a classic Canon `strong-opinion` shape (see principle counts in `CLAUDE.md` — 33 strong-opinions). Likely already encoded as a simplicity/YAGNI principle, but a named "scope discipline" principle may be worth adding explicitly if absent. |
| 3 | Don't edit unrelated code (scope discipline) | **Partial overlap** | Canon tracks files-changed per workspace and has `file claims` + worktree isolation (`canon-reference.md:86, 120`). The reviewer catches out-of-scope changes. But there is no pre-write hook that *rejects* edits outside the declared task scope — it's a post-hoc review concern, not a runtime guardrail. |
| 4 | Encode these rules into a `CLAUDE.md` that every agent reads | **Duplicate** | Canon's entire architecture is CLAUDE.md-per-directory plus principle injection via hooks (`hooks/principle-inject.sh`). More structured: severity levels, layer-specific matching, drift tracking. |
| 5 | Treat LLM coding failure modes as engineering problems with written rules | **Duplicate** | The Canon principles library (54 principles across rules/strong-opinions/conventions) is exactly this, at industrial scale. |
| 6 | Lightweight: one file, copy-paste, share publicly | **Non-fit** | Canon is a full harness (MCP server, state machine, worktrees, SQLite). The "one CLAUDE.md you paste" shape is architecturally incompatible with Canon, though Canon can consume such a file per-directory. |
| 7 | "AI coding agent failure-mode catalog" as a reusable artifact | **Novel-ish** | Canon has principles but no curated "failure modes this principle prevents" cross-index. Agents see principles; they don't see "this rule exists because agents keep doing X." |

---

## Adoption Candidates

### 1. Scope-enforcement pre-write hook (from Karpathy #3)

Canon tracks file claims and reviewer catches out-of-scope edits after the fact. A **pre-write hook** that checks `Edit`/`Write` targets against the workspace's declared affected-files set and warns (or blocks on `rule` severity) would move scope discipline from post-hoc review into runtime. Fits Canon's hook model (`hooks/principle-inject.sh` pattern). Cheap; high-value for Karpathy's most cited failure.

**Fit:** Good. Hook-layer addition, orchestrator untouched. Pairs with existing file-claim infrastructure.

### 2. Failure-mode annotations on principles (from Karpathy #7)

Each principle could carry an optional `mitigates:` field listing the LLM failure modes it addresses ("over-abstraction", "fabricated API", "unverified assumption"). The `get_principles` tool could surface this so agents see *why* a rule exists, and the learner could cluster principles by failure mode they prevent. Makes the principle library legible as a failure-mode defense, not just a style guide.

**Fit:** Good. Metadata extension; no behavior change required. Slots into the principle frontmatter schema and the `list_principles` output.

### 3. Transcript-to-spec extractor (from SpecStory #8 + roadmap Item 28)

SpecStory's "chats as durable intent" collides cleanly with Canon roadmap **Item 28 (Idea-to-Spec Flow)**. Canon already records agent transcripts via `get_transcript`; what's missing is an extractor that mines a conversational `explore` or `chat` session and emits a structured spec artifact usable as input to `feature`/`epic`. This validates and sharpens Item 28 — the spec output format matters, and treating transcripts as the raw material is the right primitive.

**Fit:** Good. Reshapes Item 28 rather than adding new scope. Uses existing transcript storage; adds a new artifact template + a spec-synthesis agent role.

### 4. Cross-workspace transcript search (from SpecStory #3)

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

---

## Summary of the Fit Assessment

**SpecStory** and Canon agree on "intent is durable," but SpecStory builds it around raw chat capture across IDEs while Canon builds it around structured artifacts (plans, principles, drift, scribe-synced `CLAUDE.md`s). The productive overlap is exactly the Idea-to-Spec flow (roadmap Item 28) — SpecStory validates that taking conversation seriously as input to specs is worth doing, and suggests the transcript as the right raw material. Cross-tool aggregation and public chat sharing are non-fits.

**Karpathy's rant** is a compressed version of what Canon's principles library already does: codify LLM failure modes as written rules the agents read. The two ideas worth stealing are (a) a **runtime scope-enforcement hook** that catches drive-by edits before they happen (Canon currently only catches them in review), and (b) **failure-mode annotations** on principles so the rules are legible as "why this exists," not just "what to do." Both are cheap additions that sharpen Canon's existing framing.

Everything else is either already covered (researcher-before-implementor, CLAUDE.md per directory, local-first) or architecturally incompatible (one-file harness, cross-IDE SaaS).
