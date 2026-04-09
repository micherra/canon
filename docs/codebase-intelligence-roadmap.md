# Codebase Intelligence Roadmap

Inspired by [Repowise](https://github.com/repowise-dev/repowise). Cross-referenced against [ADR-PACK](.ai/ADR-PACK.md) and [agent-skills analysis](.ai/agent-skills-analysis.md) to isolate what's genuinely new.

## What's Already Covered

These Repowise-inspired ideas are fully addressed by planned ADRs — no separate work needed:

| Idea | Covered By | How |
|------|-----------|-----|
| Decision records / `get_why()` | **ADR-019** (execution history) | Structured `decisions` table, provenance chains, `get_history` tool, staleness tracking. More ambitious than the Repowise equivalent. |
| Composite context tool | **ADR-008** (context assembly policy) | Pre-injects file affinity, KG summaries, topology, and conventions into spawn prompts at pipeline time. Automatic injection > on-demand tool call. |
| CLAUDE.md auto-generation | **ADR-008** makes it unnecessary | Dynamic injection replaces static file stuffing. Also high-risk (formatter bug degrades every agent). |
| Ownership intelligence | **Deferred** | `git blame` is expensive, low signal for AI agents, useless in single-developer projects. |

## The Real Gap

None of the 25 ADRs add **git-mined behavioral signals** to the knowledge graph. The KG has structural edges (imports, calls, inheritance) but no temporal signals. Agents don't know which files are volatile, which change together, or how stale a review is.

This is new infrastructure that feeds into ADR-008's context assembly pipeline as additional data sources — not standalone tools.

---

## Phase 1: Git Intelligence Layer

Build hotspot scoring and co-change detection together. They share git log parsing infrastructure — **parse once, extract both signals** in a single pass.

### 1a. Hotspot Scoring

**Status:** not started
**Effort:** small
**Impact:** high — identifies where risk concentrates

Compute `churn × complexity` per file. High-churn, high-complexity files are where bugs cluster.

**Where it surfaces:**
- ADR-008 pipeline injects hotspot score into agent context at spawn time
- `show_pr_impact` highlights hotspot files in the diff
- `get_file_context` returns hotspot score
- Reviewer knows "this is the most volatile file in the repo" without asking

**Implementation sketch:**
- Churn: commit count in lookback window, **weighted by recency** (exponential decay on commit timestamps — a file churned 6 months ago but stable since is not a current hotspot)
- Complexity: line count as proxy for v1
- Score: `churn_percentile × complexity_percentile`
- Top 25% = hotspot
- Persist in KG database (`hotspot_scores` table) with `computed_at_commit` SHA
- **Lazy recomputation:** recompute when pipeline reads and HEAD differs from `computed_at_commit`

### 1b. Co-Change Detection

**Status:** not started
**Effort:** medium — new data source, not an extension of the existing graph scanner
**Impact:** high — hidden coupling is invisible today

Mine git history for files that frequently change together without explicit import relationships.

**Where it surfaces:**
- ADR-008 pipeline injects co-change warnings when task files have known partners
- `show_pr_impact` warns "you changed A but B usually changes with it"
- `get_file_context` shows co-change partners

**Implementation sketch:**
- **New git parser module** alongside graph infra (the scanner walks filesystem/parses imports — it knows nothing about git)
- Parse `git log --name-only` to extract per-commit file groups
- **Jaccard coefficient** (`co-commits / union of commits`) ≥0.3, not raw co-commit count
- **Separate edge type** in KG: `co_changes` in a dedicated `co_change_edges` table, not mixed with structural edges. File-level, not entity-level. Confidence field set to Jaccard score.
- **Configurable exclusion list** for noise: lockfiles, config files, mirrored test files
- Incremental: persist `last_scanned_commit` SHA, only scan new commits
- Rename tracking: accept some noise in v1, document the limitation

### Shared Infrastructure

- **Single git pass:** One traversal of `git log` produces both churn counts (for hotspots) and file-group co-occurrence (for co-change)
- **Lazy staleness:** Both signals store `computed_at_commit` SHA. ADR-008's pipeline checks HEAD vs. stored SHA and triggers recomputation when they differ. No background daemon.
- **Storage:** New tables in the existing SQLite KG database (`knowledge-graph.db`). The `kg-schema.ts` migration system handles schema evolution.

### ADR-008 Integration

When ADR-008 lands, it defines pipeline stages that inject context at spawn time. Git intelligence plugs in as additional data sources for stage 1 (`resolve-context`):

- File affinity resolution (already in ADR-008) gains hotspot scores and co-change partners for each file in scope
- The `intent` parameter (review/implement/research) controls which signals are included — reviewer gets hotspot warnings and co-change alerts, implementor gets co-change partners for awareness
- Item-count budgeting (already in ADR-008) caps how many co-change partners are injected

No new MCP tool needed. The delivery vehicle is the existing pipeline.

---

## Phase 2: Confidence Decay for Drift

**Status:** not started
**Effort:** medium
**Impact:** medium — prioritizes review attention

Replace binary pass/fail with a confidence score (0.0–1.0) that decays as code changes accumulate without re-review.

**Where it surfaces:**
- `get_drift_report` sorts by "most overdue for review"
- `get_compliance` shows decay trends
- ADR-008 pipeline can include compliance confidence per file in agent context

**Implementation sketch:**
- Start at 1.0 after a passing review
- **Compute dynamically** in `get_drift_report` from review timestamp + subsequent commit history — no persisted decaying score
- Decay multiplier per commit (×0.85), **weighted by change size** from `git diff --stat`
- Time decay (×0.95 per week)
- **Configurable threshold** (default 0.5) for "needs re-review"

**Dependency:** Benefits from Phase 1's git parser (commit history traversal is shared infrastructure).

---

## Future Consideration: Test Coverage Mapping

Knowing which tests exercise which files is directly actionable — when an agent modifies `foo.ts`, knowing that `bar.test.ts` covers it means the agent can run those specific tests. The KG already has a `tests` edge type from static import analysis, but actual coverage data would be more accurate.

Worth evaluating after Phase 2 if coverage tooling (Istanbul/c8/nyc) is available in the project.

---

## Relationship to Other Planned Work

### Agent-Skills Companion Work (Cohort 4)

The [agent-skills analysis](.ai/agent-skills-analysis.md) identifies behavioral gaps — how agents think and act. This roadmap identifies data gaps — what agents have access to. Zero dependency between them; they can land in parallel.

| Agent-Skills Work | Type | Status |
|---|---|---|
| `agent-structured-triage` rule | Behavior | Not started |
| `agent-surface-assumptions` rule | Behavior | Not started |
| `agent-simplify-before-extending` rule | Behavior | Not started |
| Anti-rationalization table amendments | Behavior | Not started |
| Enriched domain primers (frontend, backend-api, deprecation) | Context | Not started |
| `measure-before-optimizing` principle | Principle | Not started |
| `define` flow (idea → spec) | Flow | Not started |
| `pre-launch-check` fragment gate | Flow | Not started |

### ADR-PACK Dependencies

Git intelligence has no hard ADR dependencies — it can be built now. But it integrates best after:

- **ADR-005** (KG consolidation) — new tables live in the consolidated KG database
- **ADR-008** (context assembly) — the delivery mechanism for injecting git signals into agent prompts

If built before ADR-008, the signals surface through existing tools (`get_file_context`, `show_pr_impact`). When ADR-008 lands, they automatically flow into spawn prompts via the pipeline.
