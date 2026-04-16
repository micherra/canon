# Canon MCP & Intelligence Roadmap

**Status:** proposed — companion to `docs/agent-teams-migration-plan-v2.md`
**Owner:** Canon maintainers
**Last updated:** 2026-04-14

Independent of the Phase 1–3 migration, this roadmap covers MCP tool improvements, knowledge graph intelligence, self-improving skills, and memory architecture. All changes are backward-compatible — they improve existing tools without breaking the legacy path. Can be executed in parallel with any migration phase.

---

## P0 — Reduce tool calls per spawn

| Tool | Change | Why |
|------|--------|-----|
| `get_principles` | Accept `file_paths: string[]` (array) in addition to `file_path: string`. Return deduplicated principles across all files. | The lead calls this before every spawn. For wave tasks with 5 files, that's 5 tool calls → 1 batch call. |
| `get_file_context` | Accept `file_paths: string[]`. Return context for all files in one response. | Same rationale. Batch saves tool calls and round-trip latency. |
| `get_context` | **New composite tool.** `get_context({ file_paths, include: ["principles", "file_context", "drift", "graph"] })` returns everything in one call. Replaces the 3-4 separate MCP calls the lead makes before every spawn. Essentially the legacy enrichment service (`context-enrichment.ts`) exposed as a standalone MCP tool — which is what it should have been all along instead of a pipeline stage. | Most impactful simplification. One call replaces three-four. Lead or agent calls once, gets principles + KG summaries + drift signals + graph metrics in one response. |

**Backward-compatible:** existing single-tool calls still work. `get_context` is additive.

---

## P1 — Prepare tools for the new model

| Tool | Change | Why |
|------|--------|-----|
| `init_workspace` | Add journal initialization — create `journal.json` when workspace is created. Add legacy workspace detection — warn if workspace has flow state but no journal. | Required for Phase 1 journal tool. The journal needs a workspace file. Legacy detection needed for Phase 3a flag flip safety. |
| `report_result` | Audit and simplify. Strip transition evaluation, convergence detection, wave result handling. Keep board-update and artifact-validation. | ~1,000+ lines, much serving the state machine. Trim to what the new model needs. |
| `record_agent_metrics` | Add `source` field: `"agent"` (called by agent directly) vs `"lead"` (lead reporting on behalf of subagent from self-reported metrics). | Distinguishes agent-reported vs lead-parsed metrics in analytics. |

---

## P2 — Consolidation and cleanup

| Tool | Change | Why |
|------|--------|-----|
| 6 `write_*` → 1 `write_artifact` | Consolidate `write_plan_index`, `write_test_report`, `write_review`, `write_implementation_summary`, `write_research_synthesis`, `write_design_brief` into one `write_artifact({ type, workspace, data })`. Same schema validation, same machine-readable sidecars, one tool registration instead of six. | Cleaner MCP surface. Agents discover and learn one tool instead of six. Less registration code. |
| `update_board` | Audit for unused operations. The new model primarily uses `complete_flow` and `set_metadata`. Operations that serve the state machine (enter, skip, block, transition) become dead code after Phase 3. **Consider merging board tracking into the journal** — instead of two parallel tracking systems, the journal becomes the single source of truth for flow state. `update_board` simplifies to just `complete_flow` (analytics aggregation for DriftStore). | 558 lines with significant overlap with the journal. One tracking system is simpler than two. |
| `init_workspace` | Remove cache prefix (was for prompt pipeline caching — not needed). Remove progress.md seeding (journal replaces this). Keep: dir creation, preflight checks, journal initialization. | Simplifies a 604-line file. Removes dead concerns from the pipeline era. |
| `report_result` | Strip transition evaluation, convergence detection, wave result handling. Keep: record agent finished, store status + artifacts, update metrics. ~1,000+ lines → ~50 lines. | Most of the code serves the state machine. The new model needs only the recording function. |
| `simulate_flow` | Evaluate: repurpose as runbook dry-run, or delete. If flows are gone, simulation has no target. | Dead tool after Phase 3 unless repurposed. |
| `load_flow` | Simplify to `load_runbook` — parse markdown frontmatter YAML instead of flow YAML with fragment resolution. Or delete if the lead can just Read the runbook file directly. | Fragment inclusion, transition validation, state type resolution are all state-machine concerns. |

---

## P3 — Intelligent domain classification and KG intelligence

### `infer_domains` — KG-powered domain classification

New MCP tool: given target file paths, return which domain skills are relevant. **Replaces the hardcoded layer mapping** in `.canon/config.json` with KG-inferred classification.

Given file paths, the tool classifies domains using three signal layers:

1. **Structural** (from KG): analyze `imports` and `imported_by` edges.
   - File imports HTTP framework (Express, Fastify, Hono) → `backend-api`
   - File imports ORM/query builder (Prisma, Drizzle, pg) → `backend-data`
   - File imports React/Vue/Svelte/DOM APIs → `frontend`
   - File imports test framework (vitest, jest) → `testing`
   - File only imported by test files → `testing`
   - High in-degree, low out-degree → shared/utility (no domain skill needed)

2. **Semantic** (from KG summaries + `semantic_search`): content-based classification.
   - Auth/session/credential/token handling → `authentication-security`
   - Migration/schema change/rollback → `migration-strategy`
   - Logging/metrics/tracing → `observability`
   - Error handling/retry/circuit breaker → `error-handling`
   - Cache/perf/optimization/benchmark → `performance`
   - CI/CD/deploy/Docker/Terraform → `devops-ci`
   - Accessibility/ARIA/screen reader → `accessibility` (subset of frontend)

3. **Heuristic** (fallback when KG data unavailable): directory path patterns.
   - `src/api/`, `routes/`, `controllers/` → `backend-api`
   - `src/db/`, `models/`, `migrations/` → `backend-data`
   - `src/components/`, `src/pages/`, `src/ui/` → `frontend`
   - `infra/`, `deploy/`, `.github/` → `devops-ci`

Returns: `{ domains: ["backend-api", "authentication-security"], confidence: "high", source: "structural" }`

**Deprecation path:** Once `infer_domains` is validated, the hardcoded `layers` mapping in `.canon/config.json` becomes optional fallback configuration.

### Community detection (inspired by [Graphify](https://github.com/safishamsi/graphify))

Canon's KG already detects cycles (`in_cycle`, `cycle_peers`) and computes hub scores (`in_degree`, `out_degree`, `is_hub`). Extend with Leiden/Louvain community detection — clustering the dependency graph into architectural communities by edge density.

Extension to `codebase_graph`: during graph generation, run community detection on the file-level dependency graph. Store cluster assignments as a `community_id` field on file nodes. This enables:
- **Architect wave assignment**: files in the same community should be in the same wave (tightly coupled)
- **Domain inference**: communities strongly correlate with domains — a cluster of files that all import Express is likely `backend-api`
- **Cross-community change risk**: changes spanning multiple communities have higher blast radius
- **"God nodes"**: files with high betweenness centrality connecting multiple communities — riskiest to change

Canon already has `ui/lib/clustering.ts` (PR change story grouping) and `services/diff-cluster.ts` (diff fanout). Exposed via `graph_query` (`community_id` in results) and `get_file_context` (`community` in `graph_metrics`).

### Confidence-scored edges

Canon's KG edges are currently binary. Adopt tiered confidence:
- **Structural edges** (imports, calls, inheritance): confidence 1.0 — AST-extracted, deterministic
- **Co-change edges** (already in KG via `co_change_edges.jaccard`): confidence = Jaccard score (0.0-1.0) — already implemented
- **Semantic edges** (from `infer_domains` and `semantic_search`): confidence = model confidence — new
- **Decision edges** (from architect decisions promoted to KG): confidence 1.0 — human-authored

A `confidence` column on edge tables lets consumers filter. The `graph_query` tool gains an optional `min_confidence` parameter.

### Design rationale as graph nodes

Graphify mines `# NOTE:`, `# IMPORTANT:`, `# HACK:`, `# WHY:` comments and turns them into `rationale_for` graph nodes. Canon's architects produce decision documents at `{workspace}/decisions/`.

After flow completion, the learner promotes decisions to KG nodes:
```
(decision: "use-jwt-not-sessions") --[rationale_for]--> (file: src/auth/session.ts)
(decision) --[made_in]--> (flow_run: ws-042)
(decision) --[tension_with]--> (principle: stateless-services)
```

Makes architectural rationale queryable from the graph. Combined with memory decay (P5), superseded decisions naturally lose weight.

---

## P4 — Self-improving skills (inspired by [Cognee](https://www.cognee.ai/blog/deep-dives/building-self-improving-skills-for-agents))

Skills should be living artifacts that improve through feedback loops, not static files.

### Flow outcome tracking (journal enhancement)

Add a `flow_outcome` record to the journal's completion data. When `verify_completion` runs at flow end, record:
- Which domain skills were loaded for each step
- Which MCP tools each agent called (from `record_agent_metrics`)
- Quality signals: review verdict (clean/warning/violation), test pass rate, fix iteration count
- Flow duration and total spawns

### Skill effectiveness tracking

Over time, the learner analyzes journal outcome data to recommend:
- Domain skills that should be loaded more often (high correlation with clean reviews)
- Domain skills that should be updated (loaded frequently but fix cycles still happen)
- New skills that should be created (recurring patterns in agent memory not captured in any skill)
- Agent `maxTurns` adjustments (consistent over/under budget)

### Graph-structured agent memory (future, post-migration)

Currently agents write freeform `MEMORY.md`. Inspired by [Cognee's custom graph models](https://www.cognee.ai/blog/deep-dives/expanding-custom-graph-models-for-reliable-agent-memory-and-retrieval), memory could become nodes in Canon's KG:

```
(engineer) --[learned]--> (pattern: "auth module requires JWT setup before tests")
(pattern) --[applies_to]--> (file: src/auth/session.ts)
(pattern) --[discovered_in]--> (flow_run: ws-042)
(pattern) --[effectiveness: 0.9]--> (domain_skill: authentication-security)
```

Benefits: queryable via `graph_query`, cross-agent sharing, pruning/weighting, cascade expansion.

---

## P5 — Memory architecture (inspired by [agentmemory](https://github.com/rohitg00/agentmemory))

### Memory decay and strengthening

Implement Ebbinghaus-style decay: memories lose priority over time unless accessed. Frequently confirmed patterns strengthen.

Implementation: memory entries gain `last_accessed` and `access_count` fields. The learner periodically prunes entries not accessed in N days (configurable, default 30). Entries confirmed by multiple flow runs gain higher weight.

### 4-tier memory hierarchy

| Tier | What | Canon source | Canon storage |
|------|------|-------------|---------------|
| **Working** | Raw observations from current flow | Journal `log_step` entries + `flow_outcome` | `journal.json` (per workspace, ephemeral) |
| **Episodic** | Compressed flow summaries | Learner produces from journal data at flow end | DriftStore `FlowRunEntry` + agent memory |
| **Semantic** | Extracted facts and patterns | Agent `MEMORY.md` entries | `MEMORY.md` or KG nodes (future) |
| **Procedural** | Decision patterns that become skills | Learner analyzes semantic patterns across flows | Proposed skills or principle amendments |

### Token budget for memory injection

Cap memory injection at ~2,000 tokens of highest-weighted entries (by `access_count × recency`). The `agent-context-check` skill instructs: "When reading your MEMORY.md, read only the top section (up to 2000 tokens)."

### What Canon already does better
- Structural knowledge graph (imports, calls, dependencies) — richer than entity-only graphs
- Principle-grounded review — memory feeds into a compliance system
- Artifact contracts — structured outputs, not free-form observations
- Journal with `flow_outcome` — structured quality signals, not raw tool-use captures

---

## P6 — Code review intelligence (inspired by [Anthropic's /code-review](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md) and [local-code-review](https://github.com/AlexIzh/local-code-review))

Canon's PR review has a rich MCP app (blast radius, change stories, violation cards) but misses three capabilities the native `/code-review` and local-code-review tools demonstrate. The improvements span three surfaces — terminal, MCP app, and PR comments — each playing to its strengths.

### Surface roles

| Surface | Strength | Canon's role |
|---------|----------|-------------|
| **Terminal** | Quick feedback loop. Developer reads, fixes, re-runs. No context switching. | Review → fix → re-review loop. Confidence-scored findings. Structured feedback to engineer. |
| **MCP App** (`ui://canon/pr-review`) | Rich visualization. Graphs, clusters, blast radius. | Dependency impact, hotspot overlay, change stories, co-change warnings. Read-only — no editing. |
| **GitHub PR comment** | Persistent. Visible to all reviewers. Line-linked. | Final review output with Canon principle violations and GitHub-linked code references. |

### Confidence scoring for review findings

Canon's reviewer currently gives binary verdicts (clean/warning/violation). Adopt confidence scoring from Anthropic's `/code-review`:

```
0:   Not confident, likely false positive
25:  Somewhat confident, might be real
50:  Moderately confident, real but minor
75:  Highly confident, real and important
100: Absolutely certain, definitely real
```

Default threshold: 80. Findings below threshold are suppressed. The reviewer is opus-powered — it can score its own confidence per finding. This reduces noise and builds trust in the review output.

Implementation: `write_review` MCP tool gains a `confidence` field per violation entry. The MCP app filters by threshold. PR comments only include high-confidence findings.

### Parallel multi-perspective review

Anthropic's `/code-review` spawns 4 agents in parallel: 2× CLAUDE.md compliance, 1× bug detector, 1× history analyzer. Canon should adopt a similar pattern using agent teams:

| Reviewer teammate | Focus | Inputs |
|-------------------|-------|--------|
| Principle compliance | Canon principle violations | Matched principles + diff |
| Bug detection | Logic errors, edge cases | Diff only (not pre-existing) |
| Security scan | Vulnerabilities, auth issues | Diff + `security-checklist` skill |
| History context | Patterns from git blame, co-change, hotspots | Git intel data + diff |

Spawn as an agent team (not sequential subagents) — teammates review in parallel, producing independent findings. Lead aggregates with confidence scores and deduplicates.

This replaces Canon's current single-reviewer approach with a team that covers more surface area in the same wall-clock time.

### Inline diff view in MCP app (read-only)

The MCP app currently shows violations as disconnected cards. Add an inline diff view with Shiki syntax highlighting where violations are pinned to their line numbers:

```
  41 │ } catch (err) {
  42 │   // silently ignore        ← [VIOLATION: fail-closed-by-default, confidence: 92]
  43 │ }                               This catch silently swallows the auth error.
```

Not for editing — the MCP app is a visualization surface. But seeing violations IN CONTEXT on the actual diff is dramatically more useful than a card that says "violation in auth.ts."

Implementation:
- `show_pr_impact` already has the diff (via `getPrReviewData`)
- New component: `DiffView.svelte` with Shiki syntax highlighting
- Violations pinned to line ranges from the review data
- Toggle between current cluster/card view and inline diff view

### Outdated violation detection

When the engineer fixes code after a review, the re-review should know which violations are potentially resolved. Track which diff lines each violation was pinned to. On re-review:
- Lines that changed since the last review → violations marked "outdated" (potentially resolved)
- Lines unchanged → violations persist
- New lines → new analysis only

Implementation: `store_pr_review` persists line ranges per violation. On re-review, `show_pr_impact` compares stored ranges against current diff. The `review_code` tool gains an `outdated_violations` input so the reviewer knows what to focus on.

### GitHub-linkable output

Canon's review output should produce clickable GitHub line links:
```
https://github.com/owner/repo/blob/[full-sha]/src/auth.ts#L42-L48
```

The shipper uses these when posting PR comments. Requires full SHA (not abbreviated) and `#L` line notation with range.

### Terminal review flow

```
/canon:review
  → Lead spawns 3-4 reviewer teammates in parallel
  → Aggregated findings with confidence scores (threshold 80)
  → Developer reads terminal output, asks Claude to fix
  → canon-engineer fixes in terminal
  → /canon:review again
    → outdated violations flagged, new analysis on changed lines
  → Clean → /canon:review --comment posts to PR with GitHub line links
```

This replaces the current sequential reviewer spawn with a parallel team, adds confidence scoring to reduce noise, and closes the review → fix → re-review loop with outdated detection.
