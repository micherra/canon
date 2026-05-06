# Codebase Intelligence Roadmap

Inspired by [Repowise](https://github.com/repowise-dev/repowise). Covers git-mined behavioral signals for the knowledge graph — structural data (imports, calls, inheritance) was already present; temporal signals were the gap.

---

## What's Shipped

**Phase 1a — Hotspot Scoring** — `hotspot-scorer.ts` built. Recency-weighted churn × complexity scoring, lazy recomputation keyed on `computed_at_commit` SHA. Surfaces through `get_file_context` and `get_context`.

**Phase 1b — Co-Change Detection** — `co-change-detector.ts` built. Jaccard coefficient on per-commit file groups, stored as `co_change_edges` in the KG database. Surfaces through `get_file_context` and `show_pr_impact`.

**Shared infrastructure** — `git-log-parser.ts` + `git-intel-pipeline.ts` built. Single git-log pass extracts both signals.

**ADR-008 integration** — Both signals surface through `get_file_context` and `get_context` and flow into spawn prompts via the lead's MCP tool composition.

---

## Remaining Work

### Phase 2 — Confidence Decay for Drift

Replace binary pass/fail in drift reports with a 0.0–1.0 confidence score that decays as commits accumulate without re-review.

**Implementation sketch:**
- Start at 1.0 after a passing review
- Compute dynamically in `get_drift_report` from review timestamp + subsequent commit history
- Decay multiplier per commit (×0.85), weighted by change size from `git diff --stat`
- Time decay (×0.95 per week)
- Configurable threshold (default 0.5) for "needs re-review"
- Benefits from Phase 1's git parser — commit history traversal is shared infrastructure

**Surfaces:** `get_drift_report` sorted by "most overdue for review"; `get_compliance` decay trends; ADR-008 pipeline includes compliance confidence per file in agent context.

### Test Coverage Mapping

Augment the KG's static import-based test coverage inference with actual runtime coverage data (Istanbul/c8/nyc). Worth building after Phase 2 if coverage tooling is available in the project.

---

## Agent-Skills Companion Work

These are behavioral improvements that run in parallel with the data-layer work above — no dependencies between them.

| Work Item | Type | Status |
|-----------|------|--------|
| `agent-structured-triage` rule | Behavior | Shipped |
| `agent-simplify-before-extending` rule | Behavior | Shipped |
| `agent-tdd-required` rule | Behavior | Shipped |
| Enriched domain primers | Context | 12 files in `primers/` shipped |
| `agent-surface-assumptions` rule | Behavior | Not started |
| Anti-rationalization table amendments | Behavior | Not started |
| `measure-before-optimizing` principle | Principle | Not started |
| `define` pipeline (idea → spec) | Planner mode | Not started |
| `pre-launch-check` checklist step | Runbook step | Not started |

---

## Archived

- **CLAUDE.md auto-generation** — Dynamic injection via ADR-008 replaces static file stuffing; auto-generation would be high-risk (formatter bug degrades every agent).
- **Ownership intelligence** — `git blame` is expensive, low signal for AI agents, and useless in single-developer projects.
- **Decision records / `get_why()`** — Absorbed into journal `JournalOutcome` and `FlowRunEntry` in DriftStore.
- **Composite context tool** — Shipped as `get_context` (see MCP & Intelligence Roadmap).
