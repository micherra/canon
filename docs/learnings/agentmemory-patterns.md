# Learnings from AgentMemory

Source: [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory)

## Repository Overview

AgentMemory is a persistent memory infrastructure for AI coding agents. It provides cross-session memory that lets agents retain and recall contextual information without requiring users to re-explain their codebase each session. Key stats: ~21,800 LOC TypeScript, 646 tests, 43 MCP tools, 12 automatic hooks.

**Architecture**: Built on `iii-engine` (Rust-based runtime with KV state, HTTP triggers, WebSocket streams). Zero external database dependencies — all storage is local KV with in-memory vector indexing.

**Core pipeline**: Capture (hooks) -> Process (LLM compression) -> Index (vector + BM25 + graph) -> Retrieve (hybrid search with fusion).

## Key Patterns

### 1. Four-Tier Memory Consolidation

AgentMemory models memory in four tiers inspired by human memory consolidation:

| Tier | Content | Analogy |
|------|---------|---------|
| **Working** | Raw tool observations from hooks | Short-term memory |
| **Episodic** | Compressed session summaries | Event recall |
| **Semantic** | Extracted facts, patterns, architecture knowledge | Knowledge base |
| **Procedural** | Recurring workflows, trigger-step sequences | Skill memory |

The consolidation pipeline (`consolidation-pipeline.ts`) promotes data upward:
- **Working -> Episodic**: Session summaries are generated from raw observations at session end via LLM compression
- **Episodic -> Semantic**: After accumulating 5+ session summaries, facts are extracted with confidence scores and merged (duplicate facts increase confidence)
- **Semantic -> Procedural**: Patterns occurring 2+ times are extracted as executable procedures with trigger conditions and steps

**Canon comparison**: Canon has no tiered memory. Workspace artifacts (research, plans, summaries) are flat files. The scribe agent updates CLAUDE.md and context.md but doesn't consolidate cross-session patterns. Each agent spawn starts fresh with no memory of prior sessions.

**Applicability**: Canon could benefit from a 3-tier model:
- **Episodic**: Flow completion summaries (already exist via `store-summaries` and `progress.md`, but not queryable as memory)
- **Semantic**: Extracted facts from completed flows — "this codebase uses barrel exports", "the test suite requires Node 24+", "layer violations in adapters/ were fixed in flow X"
- **Procedural**: Repeated workflow patterns — "when fixing test failures in knowledge-graph, always check kg-schema migration version"

### 2. Triple-Stream Hybrid Search

AgentMemory uses three parallel retrieval methods fused with Reciprocal Rank Fusion (RRF, k=60):

- **BM25**: Stemmed keyword matching with synonym expansion (`stemmer.ts`, `synonyms.ts`)
- **Vector**: Cosine similarity over dense embeddings (6 provider support)
- **Graph**: Entity-based traversal via knowledge graph nodes/edges

Results are diversified (max 3 per session) to prevent redundancy.

**Canon comparison**: Canon has vector-based `semantic_search` over the KG (file summaries and entities) and structural `graph_query` (callers, callees, blast radius). These are separate tools invoked independently — there is no fusion layer combining them.

**Applicability**: Canon's `context-enrichment.ts` already assembles context from multiple sources (git log, drift signals, prior workspaces, tensions). Adding a lightweight fusion step that combines KG semantic search results with structural graph data (weighted by relevance) would produce richer agent context. The RRF algorithm is simple to implement — ~30 lines of code.

### 3. Hook-Driven Observation Capture

AgentMemory captures 12 lifecycle events automatically:
- `SessionStart/End`, `UserPromptSubmit`, `PreToolUse/PostToolUse`, `PostToolUseFailure`, `PreCompact`, `SubagentStart/Stop`, `Stop`, `TaskCompleted`, `Notification`

Each observation is: validated -> deduplicated (SHA-256 fingerprint) -> privacy-scrubbed -> structured -> stored -> broadcast.

**Canon comparison**: Canon has hooks (`hooks/`) but they are pre/post tool-use interceptors for enforcement, not observation capture. Agent activity is logged via `post_event` tool (structured `agent_activity` events) and `record_agent_metrics`, but these are opt-in calls that agents must explicitly make. There is no automatic capture of what agents do.

**Applicability**: Canon already has `hooks.json` infrastructure. Adding observation capture hooks (particularly `PostToolUse` for file reads/writes and `SubagentStop` for agent results) would create a foundation for cross-session learning without requiring agent cooperation. The key insight is: **make capture automatic, not agent-initiated**.

### 4. Memory Decay and Eviction

AgentMemory manages memory lifecycle through three mechanisms:

- **TTL expiration**: Memories can have `forgetAfter` timestamps; expired entries are removed
- **Contradiction detection**: Jaccard similarity (threshold 0.9) identifies conflicting memories; older versions are marked `isLatest: false` with version chains
- **Low-value pruning**: Observations older than 180 days with importance <= 2 are evicted
- **Exponential decay**: Consolidation pipeline applies 0.9 decay factor to memory strength over time

**Canon comparison**: Canon has no memory decay. CLAUDE.md entries are permanent until manually edited. Drift store reviews accumulate indefinitely (with JSONL rotation for size). Knowledge graph data is refreshed per scan but old summaries persist. There is no concept of memory becoming stale or losing relevance.

**Applicability**: Canon's drift store (`reviews.jsonl`) and flow run analytics would benefit from decay. A principle violation that hasn't recurred in 6 months is less relevant than one from last week. Adding a `relevance_score` that decays with age and strengthens on access would let `context-enrichment.ts` prioritize recent, frequently-referenced knowledge when assembling agent prompts.

### 5. Access-Frequency Tracking

Every memory retrieval is logged with: access count, last-access timestamp, and a rolling window of 20 recent timestamps. This metadata enables:
- Identifying frequently-used knowledge (high-value for retrieval)
- Detecting stale knowledge (not accessed recently)
- Batch access recording for search results

**Canon comparison**: Canon tracks flow run history and drift reviews but doesn't track which knowledge was actually useful to agents. When `context-enrichment.ts` injects prior workspace data or drift signals, there's no feedback loop to know if agents found that context helpful.

**Applicability**: Adding access tracking to Canon's KG summaries and drift data would enable the enrichment pipeline to learn which context agents actually use. Implementation: when a spawned agent completes, record which injected context files/summaries appeared in its output artifacts. Over time, this creates a "usefulness signal" for ranking context injections.

### 6. Content-Based Deduplication

AgentMemory uses SHA-256 fingerprinting (`fingerprintId` in `schema.ts`) to deduplicate observations. The fingerprint is computed from `sessionId + tool_name + tool_input`, preventing duplicate storage of identical tool invocations.

For memories (higher-level knowledge), Jaccard similarity with a 0.7 threshold detects near-duplicates. When a new memory is >70% similar to an existing one, the old memory is superseded (`isLatest: false`) and the new one carries a version chain reference.

**Canon comparison**: Canon's `store-summaries` tool overwrites summaries by file path (upsert on `file_id`), providing implicit deduplication at the file level. But there's no deduplication for drift reviews, flow run entries, or agent-reported artifacts.

**Applicability**: The version-chain pattern (mark old as `isLatest: false`, link new to old via `supersedes`) is useful for Canon's drift store. When a principle gets multiple reviews over time, maintaining a version chain would let the drift report show trend lines — "violation count for principle X: 5 -> 3 -> 1 over 3 reviews" — without accumulating unbounded review entries.

### 7. Automatic Pattern Extraction

AgentMemory's `patterns.ts` detects behavioral patterns across sessions:
- **Co-change patterns**: Files modified together 3+ times -> "fileA and fileB are frequently modified together"
- **Error repeat patterns**: Errors occurring 2+ times -> "Recurring error: {errorKey}"
- **Rule generation**: High-frequency patterns (4+ occurrences) become actionable rules for agents

**Canon comparison**: Canon has git-intel's `co-change-detector.ts` which computes Jaccard co-change similarity from git history. But this is structural analysis of the codebase, not behavioral analysis of what agents do. Canon doesn't track which files agents tend to modify together during flows, or which errors recur across flow runs.

**Applicability**: Canon already stores flow run analytics and agent metrics. Extending `categorize-failures.ts` to detect recurring failure patterns across flows would be straightforward. The extracted patterns could feed into `context-enrichment.ts` as warnings: "This file was involved in 3 previous fix cycles — check for regressions."

### 8. Token Budget Management

AgentMemory enforces a configurable `TOKEN_BUDGET` (default 2000 tokens) for context injection. The session-start hook retrieves relevant memories via hybrid search but caps the injected context at the budget limit.

**Canon comparison**: Canon has `context-budget.ts` with tier-based item count caps (small: 5, medium: 15, large: 30 items) and `MAX_ENRICHMENT_CHARS = 6000` in `context-enrichment.ts`. This is similar in spirit but coarser — it counts items and characters rather than tokens.

**Applicability**: Canon's approach is reasonable for its current scale. If enrichment quality becomes a concern, switching to token-based budgeting (using a fast tokenizer estimate) would allow finer control. Low priority.

## Gaps and Limitations in AgentMemory

1. **No structural code analysis**: AgentMemory's knowledge graph is entity-relationship extraction from observations, not actual code structure. Canon's KG (import/export resolution, layers, blast radius, hotspots) is significantly more sophisticated.

2. **Single-project scope**: AgentMemory is designed for one developer's memory across sessions. Canon's multi-agent orchestration with parallel wave execution, file claims, and cross-agent messaging is a different architectural class.

3. **LLM-dependent consolidation**: Every tier transition requires an LLM call. At scale this adds latency and cost. Canon's git-intel pipeline is deterministic (no LLM calls for structural analysis).

4. **No principle enforcement**: AgentMemory stores what agents learned but has no mechanism to enforce architectural standards. Canon's principle system (54 principles with severity levels, compliance tracking, gate enforcement) is a distinct capability.

5. **Shallow graph**: AgentMemory's graph is extracted entities with properties. Canon's graph includes cycle detection, hub identification, layer inference, blast radius computation, and dead code detection.

## Priority Recommendations

### P0 — High impact, low effort

**1. Automatic observation capture via hooks**
Add `PostToolUse` hooks that log which files agents read/write during flows. Store in execution store alongside existing agent metrics. Enables all downstream learning without requiring agent changes.

**2. Cross-flow pattern detection**
Extend `categorize-failures.ts` to detect recurring patterns across flow runs: repeated failure modes, frequently co-modified files during Canon flows (distinct from git-level co-change), recurring principle violations. Surface in `context-enrichment.ts`.

### P1 — High impact, medium effort

**3. Memory decay for drift data**
Add `relevance_score` to drift store reviews. Decay score by 0.9 per month since last access. When `context-enrichment.ts` selects drift signals for agent context, rank by relevance score instead of recency alone. Prune entries below threshold during JSONL rotation.

**4. Access tracking for context effectiveness**
Track which context injections agents actually reference in their output. Feed back into enrichment ranking. Implementation: after `report_result`, compare injected context with agent artifacts to compute a "utilization ratio."

### P2 — Medium impact, higher effort

**5. Semantic memory tier**
After flow completion, extract facts from agent artifacts (design briefs, implementation summaries, test reports) into a semantic memory table in the KG SQLite database. Query this during `context-enrichment.ts` assembly. Distinct from file summaries — these are architectural facts and decision rationale.

**6. Hybrid search fusion for context assembly**
Add RRF fusion layer in `context-enrichment.ts` that combines KG semantic search, structural graph data, drift signals, and git-intel hotspots into a single ranked list before budget-constrained selection.

### P3 — Exploratory

**7. Procedural memory extraction**
After accumulating enough semantic memories, detect recurring agent workflows (e.g., "when adding a new MCP tool: create tool file, register in index.ts, add tests, update CLAUDE.md"). Store as procedural templates that can be injected into architect prompts for similar future tasks.
