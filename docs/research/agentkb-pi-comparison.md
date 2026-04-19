# agentkb + pi.dev vs Canon

**Sources:**
- https://github.com/isaac-flath/agentkb (HTML landing page — reachable)
- https://pi.dev — source unreachable despite fallbacks (403 on direct, archive.org mirror blocked)

**Date:** 2026-04-19

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

## pi.dev

Source unreachable despite fallbacks. Both the direct URL (`https://www.pi.dev`, HTTP 403 — likely bot challenge) and the archive.org mirror (`web.archive.org/web/2026/https://pi.dev`, blocked by the WebFetch allowlist) could not be fetched. No responsible comparison is possible.

| Idea | Classification | Canon equivalent or gap |
|------|----------------|-------------------------|
| (Landing page contents) | **Unknown — source unreachable despite fallbacks** | n/a — retry from a browser-capable fetcher or a different network path required before classification |

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

---

## Non-fits

| Idea | Why it conflicts |
|---|---|
| **Communications store (X/Twitter threads)** | Canon's scope is the local codebase and its agents. Ingesting social media threads as agent memory is orthogonal to Canon's value loop. |
| **agentkb as a drop-in replacement for Canon's principle/KG system** | Canon's principles are prescriptive (rules agents enforce), not just retrievable notes. Replacing `principles/` with a generic wiki store would lose the compliance/drift machinery (`get_compliance`, `get_drift_report`). |
| **Per-store independent git repos for sync** | Canon's artifacts live in the project repo on purpose — principles travel with the code they govern. Splitting them into sync-able side-repos would fragment the compliance story. |
| **pi.dev ideas** | Unassessable; source unreachable despite fallbacks. |
