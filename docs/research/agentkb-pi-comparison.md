# agentkb + pi.dev vs Canon

**Sources:**
- https://github.com/isaac-flath/agentkb (HTML landing page — reachable)
- https://github.com/badlogic/pi-mono (pi.dev source monorepo — reachable)

**Date:** 2026-04-19 (pi-mono section refreshed 2026-04-20)

---

## isaac-flath/agentkb

agentkb is a **local-first, file-backed memory system for coding agents** — a structured knowledge base that persists across sessions, organized into four specialized stores (Wiki, Chats, Communications, Skills) with per-store retrieval strategies. Source data lives in plain markdown/JSONL, indexes (FTS5 + PLAID semantic) are ephemeral and rebuilt from source, and every store syncs via git.

| Idea | Classification | Canon equivalent or gap |
|------|----------------|-------------------------|
| "Amnesia problem" framing — agents lack continuity across sessions | **Partial overlap** | Canon addresses continuity through `board.json` / workspace resume, `progress.md`, drift logs (`.canon/` JSONL store), and the principle library. No cross-session *conversational* memory — Canon resumes flow state, not dialogue context. |
| Four specialized stores (Wiki / Chats / Communications / Skills) | **Partial overlap** | Canon has principles (`principles/`), templates, agent definitions, and the KG — all specialized artifact types, but not organized as an agent-queryable "memory" with mixed retrieval. No chat-history store. |
| Consolidation workflow (agent extracts insights from chats → permanent wiki entries) | **Novel** | Canon has `canon:canon-learner` for pattern analysis and `canon:canon-writer` for principle authoring, but no scheduled "distill past sessions into durable knowledge" loop. Closest analog: the learner reviewing drift reports. |
| Plain markdown source + ephemeral indexes | **Duplicate** | Canon's principles and artifacts are markdown-first; the KG SQLite DB is rebuilt from source (`bounded-context-map.md`). Same pattern. |
| Git-backed sync per store | **Partial overlap** | Canon's principles and agent definitions live in the repo (git-tracked); `.canon/` runtime data is local-only. No cross-machine sync story. |
| Full-text + semantic + RRF hybrid retrieval | **Duplicate** | Canon has `semantic_search` and `graph_query` in `mcp-server/src/features/knowledge-graph/` with hybrid ranking. RRF specifically not used, but combined signals are. |
| Traceability DB — every query + expansion + ranking + result logged | **Novel** | Canon logs agent metrics (`record_agent_metrics`) and drift events but does not log KG/semantic search queries as an auditable trail. |
| Skills store loaded directly by agents | **Duplicate** | Canon's `skills/canon/` slash commands and `rules/` files are loaded per-agent at runtime. Same pattern, narrower scope. |
| Chats store (exported Claude Code / Pi transcripts, searchable markdown) | **Novel** | Canon has no transcript archive. Session output is ephemeral unless captured in `progress.md`. |
| Local-first / data ownership | **Duplicate** | Canon runs entirely on-device against the local working tree and SQLite. |

---

## pi.dev (pi-mono)

pi-mono is a **TypeScript monorepo of building blocks for coding agents and LLM infrastructure** — not a single product, but a stack: `pi-ai` (unified multi-provider LLM client), `pi-agent-core` (tool-calling and state runtime), `pi-coding-agent` (interactive CLI, the primary user-facing tool), `pi-tui` (terminal rendering), `pi-web-ui` (chat components), `pi-mom` (Slack delegator), and `pi-pods` (vLLM GPU deployment CLI). Its distinguishing stance is a push to publish open-source agent sessions (via `pi-share-hf` to Hugging Face) so that real-world tool-use, failures, and fixes become training material instead of toy benchmarks.

| Idea | Classification | Canon equivalent or gap |
|------|----------------|-------------------------|
| Unified multi-provider LLM client (`pi-ai`) | **Non-fit** | Canon runs inside Claude Code; the client is the Anthropic harness. Adding a provider abstraction layer is outside Canon's scope. |
| Agent runtime with tool-calling + state (`pi-agent-core`) | **Partial overlap** | Canon's state machine is the flow runtime in `mcp-server/src/features/orchestration/` (`drive_flow`, `init_workspace`). pi-agent-core is a lower-level primitive; Canon operates one tier up as an orchestrator over Claude Code's own agent runtime. |
| Interactive coding-agent CLI (`pi-coding-agent`) | **Non-fit** | Canon is not an agent CLI; it's a harness for Claude Code. Building a standalone CLI would duplicate the host. |
| Open-source session sharing (`pi-share-hf` → Hugging Face) | **Novel** | Canon has drift logs (`.canon/` JSONL) and `progress.md` per workspace, but no export pipeline or convention for publishing sessions as public training data. Closest analog: `record_agent_metrics` in `mcp-server/src/features/diagnostics/`. |
| Emphasis on real-world session data over benchmarks | **Partial overlap** | Canon's drift tracking and `canon:canon-learner` pattern analysis are directionally aligned (learn from real runs), but the data stays local — there is no public-corpus intent. |
| Terminal UI library with differential rendering (`pi-tui`) | **Non-fit** | Canon renders through Claude Code; no TUI surface to own. |
| Web chat components (`pi-web-ui`) | **Non-fit** | Canon has no web surface. MCP apps handle in-client visualization (`docs/reference/canon-reference.md`). |
| Slack delegator (`pi-mom`) | **Non-fit** | Canon's activation is the Claude Code skill entry point; chat-platform delegation is orthogonal. |
| vLLM GPU deployment CLI (`pi-pods`) | **Non-fit** | Canon does not operate infrastructure. |
| Monorepo packaging of agent building blocks as independent npm packages | **Novel** | Canon is a single repository with internal bounded contexts (`docs/bounded-context-map.md`), not published packages. Splitting Canon's KG, diagnostics, or principles into reusable libraries is not on the roadmap. |

---

## Worth adopting (2-4 items)

### 1. Consolidation workflow — scheduled distillation of sessions into durable principles

agentkb's standout move is the **chat → wiki consolidation** step: an agent reads recent sessions and synthesizes durable insights into permanent entries. Canon has the pieces (`canon-learner` reads drift, `canon-writer` authors principles) but no regular loop that sweeps completed workspaces for crystallizable patterns. Adding a `canon:distill` command (or a post-flow hook) that hands recent `progress.md` + drift events to the learner for principle-candidate extraction would close this gap.

**Fit:** Good. Slots into the existing learner/writer pair; no orchestrator change.

### 2. Chat/session transcript store as a searchable artifact

agentkb treats exported agent conversations as first-class, searchable markdown. Canon's `progress.md` per workspace is the closest primitive but is scoped to a single flow and not cross-queryable. A cross-workspace transcript index — even just FTS over `progress.md` files in `.canon/workspaces/` — would give the learner and guide richer historical context and make "how did we handle X last time?" answerable.

**Fit:** Moderate. Storage cost is real; retrieval belongs in the knowledge-graph bounded context.

### 3. Query traceability log for KG and semantic search

agentkb logs every query, expansion, and ranking decision for evaluation and debugging. Canon logs agent-level metrics but not individual KG/semantic-search calls. Adding a lightweight query log (JSONL, mirroring the drift store) would let Canon evaluate retrieval quality and tune ranking without guessing — useful as the KG grows.

**Fit:** Good. Additive to `mcp-server/src/features/diagnostics/`; orchestrator untouched.

### 4. Optional open-source session export (from pi-mono)

pi-mono's `pi-share-hf` publishes full agent sessions to Hugging Face so real tool-use traces become public training material. Canon already captures the raw inputs (`progress.md`, drift JSONL, `board.json`, `record_agent_metrics`) but has no export or redaction pipeline. A `canon:export-session` command that bundles a completed workspace into a sanitized, shareable archive — opt-in per workspace, with a secret-scanning pass — would let teams contribute Canon traces to public corpora without leaking internal code.

**Fit:** Moderate. Additive diagnostics feature; needs a redaction step before anything ships. Orchestrator untouched.

---

## Non-fits

| Idea | Why it conflicts |
|---|---|
| **Communications store (X/Twitter threads)** | Canon's scope is the local codebase and its agents. Ingesting social media threads as agent memory is orthogonal to Canon's value loop. |
| **agentkb as a drop-in replacement for Canon's principle/KG system** | Canon's principles are prescriptive (rules agents enforce), not just retrievable notes. Replacing `principles/` with a generic wiki store would lose the compliance/drift machinery (`get_compliance`, `get_drift_report`). |
| **Per-store independent git repos for sync** | Canon's artifacts live in the project repo on purpose — principles travel with the code they govern. Splitting them into sync-able side-repos would fragment the compliance story. |
| **pi-mono's agent runtime and CLI (`pi-agent-core`, `pi-coding-agent`)** | Canon runs inside Claude Code and treats the host's agent runtime as a given. Adopting a second runtime would duplicate and conflict with the harness Canon dispatches to. |
| **Multi-provider LLM client (`pi-ai`)** | Provider abstraction is the host's responsibility, not the orchestrator's. |
| **pi-mono's TUI / web-UI / Slack surfaces** | Canon has no first-party UI surface; interaction is through Claude Code and MCP apps. |
