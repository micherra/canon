# Canon MCP & Intelligence Roadmap

Covers MCP tool improvements, knowledge graph intelligence, self-improving skills, and memory architecture.

---

## What's Shipped

**P0 — Reduce tool calls per spawn**

- `get_principles` batch — `getPrinciplesBatch()` accepts `file_paths: string[]`.
- `get_file_context` batch — Shipped differently. Standalone batch file deleted; logic inlined into `get_context`.
- `get_context` composite — Done. Composes principles, file context, drift, and graph in one call.

**P1 — Prepare tools for the new model**

- `init_workspace` journal initialization — Done.
- `report_result` simplification — Exceeded scope. Fully deleted in PR #160, not just simplified.

**P2 — Consolidation and cleanup**

- `update_board` cleanup — Exceeded scope. Fully deleted in PR #160 (along with `board.json`, `board-sync.ts`).
- `report_result` full strip — Exceeded scope. Fully deleted in PR #160.
- `simulate_flow` deletion — Done.
- `load_flow` removal — Done.

**P3 — Intelligent domain classification and KG intelligence**

- `infer_domains` — Shipped differently. No standalone MCP tool. Implemented as `kg-tags.ts` 4-signal pipeline (directory, imports, community, hub signals). Classification is embedded in graph generation, not an on-demand tool.
- Community detection — Done. Louvain algorithm in `kg-community.ts`.
- Confidence-scored edges — Done. Co-change edges use Jaccard score; tags have per-source confidence. `min_confidence` parameter on `graph_query`.

**P4 — Self-improving skills**

- Flow outcome tracking — Done. `JournalOutcome` records domain skills loaded, tool call counts, quality signals (review verdict, test pass rate, fix iterations), and flow duration.

---

## Remaining Work

### P1 — Prepare tools (remaining)

**`record_agent_metrics` source field** — Add a `source` field: `"agent"` (agent reported directly) vs `"lead"` (lead reporting on behalf of a subagent). Distinguishes agent-reported vs lead-parsed metrics in analytics.

### P2 — Consolidation (remaining)

**`write_*` → `write_artifact`** — 5 individual write tools (`write_plan_index`, `write_test_report`, `write_review`, `write_implementation_summary`, `write_research_synthesis`) still individually registered. Consolidating into one `write_artifact({ type, workspace, data })` would reduce MCP surface and make discovery easier for agents. (`write_design_brief` was the 6th in the original plan — confirm its status before consolidating.)

### P3 — KG intelligence (remaining)

**Design rationale as graph nodes** — After flow completion, the learner promotes architect decisions from `{workspace}/decisions/` into KG nodes with `rationale_for`, `made_in`, and `tension_with` edges. Makes architectural rationale queryable from the graph.

### P4 — Self-improving skills (remaining)

**Skill effectiveness tracking** — The learner analyzes journal outcome data across flows to recommend: domain skills that should load more often, skills that need updating, new skills that should be created, and `maxTurns` adjustments.

**Graph-structured agent memory** — Agents currently write freeform `MEMORY.md`. Structured memory as KG nodes would enable queryability via `graph_query`, cross-agent sharing, and weighting/pruning. Deferred until after memory architecture (P5) is in place.

### P5 — Memory architecture

**Memory decay and strengthening** — Ebbinghaus-style decay: memories lose priority over time unless accessed. Memory entries gain `last_accessed` and `access_count` fields. Learner periodically prunes entries older than N days (default: 30). Entries confirmed across multiple flow runs gain higher weight.

**4-tier memory hierarchy** — Formalize the existing partial implementation:

| Tier | What | Canon storage |
|------|------|---------------|
| Working | Raw observations from current flow | `journal.json` (ephemeral) |
| Episodic | Compressed flow summaries | DriftStore `FlowRunEntry` + agent memory |
| Semantic | Extracted facts and patterns | `MEMORY.md` or KG nodes (future) |
| Procedural | Decision patterns that become skills | Proposed skills / principle amendments |

### P6 — Code review intelligence

**Confidence per violation** — `write_review` gains a `confidence` field (0–100) per violation entry. Default threshold: 80; findings below are suppressed. Reduces noise and builds trust in review output.

**Parallel multi-perspective review** — Shipped partially as file-partition dispatch (not perspective-based). The planned perspective-based split — principle compliance, bug detection, security scan, history context — is not yet built.

**Inline diff view** — New `DiffView.svelte` component in the MCP app showing violations pinned to line numbers with Shiki syntax highlighting. Not for editing — visualization only.

**Outdated violation detection** — Track which diff lines each violation was pinned to. On re-review, violations on unchanged lines persist; violations on changed lines are marked "outdated" (potentially resolved).

**GitHub-linkable output** — Review output includes clickable GitHub line links (`/blob/[full-sha]/path#L42-L48`) for use when posting PR comments.

---

## Archived

- **`get_file_context` standalone batch file** — Logic inlined into `get_context`; standalone file deleted.
- **`report_result`** — Fully deleted in PR #160, not simplified per original plan.
- **`update_board`** — Fully deleted in PR #160; journal is now the sole tracking substrate.
- **`load_flow` → `load_runbook`** — Removed entirely rather than simplified; orchestrator reads runbook files directly.
