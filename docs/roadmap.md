# Canon Roadmap

Forward-looking planning document. "What's Shipped" is a brief summary of completed work; the main body covers what remains.

---

## What's Shipped

**Tier 0 — Coordination Layer Migration (complete)**

- **0.1 Agent teams migration** — `drive_flow`, `load_flow`, `simulate_flow` deleted. All 28 flow YAML files deleted. `CANON_AGENT_TEAMS_MODE=on` active, 20/20 soak gate passed.
- **0.2 Unified work tracking** — Shipped differently from plan. PR #160 deleted `board.json`, `board-sync.ts`, `update-board.ts`, `report-result.ts` (-10,316 lines). Journal is now the single tracking substrate; DAG execution uses native `TaskCreate` for parallel work.
- **0.3 Runbooks replace flow YAML** — Planner synthesizes runbooks via `canon:synthesize` skill. `init_workspace` accepts `runbook_content`/`brief_content` and validates mandatory tail.

**Tier 1**

- **4 Doc sync on fast-path** — Shipped differently. Scribe is in the mandatory tail for all runbooks including fast-path; it runs every time and decides internally whether to update.

**Tier 2**

- **10 Durable agent metrics** — Shipped differently. `record_agent_metrics` + `finalize_workspace` aggregates into `FlowRunEntry` in DriftStore. `get_build_history` + `get_cross_run_analysis` provide query surface. (Roadmap said "rollup + query tool" — this is that, via different mechanism.)
- **11 Architectural boundary cleanup** — Done. `.dependency-cruiser.cjs` tracks 5 justified exceptions.

**Tier 4**

- **17 Background janitor** — Partial scope shipped. Worktree/workspace pruning and archiving only. Decision extraction, transcript trimming, KG refresh, and learner trigger not built.

**Tier 5**

- **22 Deterministic agent evaluation** — Partial scope shipped. `skills/canon/evals/` has fixtures and `run-evals.sh`. Scoped to intent classification only; no broader agent behavior coverage.

**Tier 6**

- **9 Worktree sandboxing** — Partial. Permission allowlists via `injectWorktreeSettings()` shipped. Hard path enforcement and audit log not built.
- **20 Workflow pattern mining** — Partial. Learner agent exists; `get_build_history`/`get_cross_run_analysis` and `cross-run-analyzer.ts` are in place. Automated pattern detection algorithm not built.

---

## Remaining Work

### Tier 1 — Quick Wins

These are small, low-prerequisite improvements. Earlier items have fewer dependencies and are more likely to land sooner.

#### 1. Preserve Agent Reasoning Across Context Compaction

Capture the compaction summary when Claude Code compacts its context window and append it to the active workspace's progress log. Blocked on Claude Code exposing a compaction hook — no viable fallback heuristic exists if that hook isn't available.

#### 2. Tool-Level Loop Detection

When an agent repeats the same tool call with the same inputs three times in a row within a single turn, pause the flow and surface the loop. The current stuck detector catches iteration-level loops but misses tight within-agent retry spirals.

#### 3. In-Flight Spawn Watchdog

Track a start timestamp for every agent spawn. When a spawn exceeds a configurable wall-clock threshold (default: 20 minutes for implementors), surface the long-running agent with options to wait, cancel, or intervene. Canon is currently blind to single-agent spin during the window between "agent started" and "agent reported."

#### 5. Proactive Documentation Gap Detection

Before classifying a diff, the scribe scans for directories that contain source files but no `CLAUDE.md`. Finds gaps that passive diff-watching never catches.

#### 6. Explicit Code-to-Docs Mapping

A project-local config declaring which source directories are documented by which `CLAUDE.md` files. Eliminates scribe guesswork and makes sync behavior predictable.

#### 7. Smarter Scribe Spawn Decisions

Pre-classify the diff for signals that reliably warrant doc updates (exported signature changes, new routes, schema changes). The scribe focuses judgment on boundary cases rather than re-classifying obvious ones.

---

### Tier 2 — Infrastructure Refinements

#### 9. Worktree Sandboxing (remaining gaps)

Two gaps remain on top of the shipped permission allowlists: hard path enforcement that denies writes outside the worktree, and an audit log recording every auto-approved action.

---

### Tier 3 — Intelligence & Observability

#### 12. Confidence Decay for Drift Reports

Replace binary pass/fail with a 0.0–1.0 confidence score that decays as code changes accumulate without re-review. Sorts `get_drift_report` by "most overdue for review" instead of binary compliance.

#### 13. Hotspot and Co-Change-Aware Scribe

Feed hotspot scores and co-change partner data from the git intelligence layer into scribe spawn context. High-churn files get extra attention; co-change partners that diverge trigger warnings.

#### 14. Documentation Staleness in Drift Reports

Add a documentation freshness dimension alongside principle compliance. Each `CLAUDE.md` gets a "commits since last sync" count and decaying confidence score.

#### 16. Effort Budgets

Maximum tool calls per state, wall-clock duration limits, and maximum agent spawns per flow. A "focus and wrap up" note injected when approaching the limit; pause for approval when hit. Was supposed to re-home onto hooks/task-list metadata after Tier 0 — still not built.

---

### Tier 4 — Cross-Session Learning & History

#### 17. Background Janitor (remaining scope)

Decision extraction, transcript trimming, KG refresh, and learner-trigger are not yet built. The pruning/archiving portion shipped; the rest remains.

#### 18. Short-Term Memory for Recently-Touched Areas

Capture compact observations when agents touch a subsystem and attach them with a short expiry (default: 7 days). The next agent in the same area gets those observations pre-injected.

#### 19. Cross-Session Error and Fix Memory

When an implementor summary records a fix for a specific failure pattern, persist the association. Inject known fixes into fixer context as starting hypotheses.

#### 20. Workflow Pattern Mining (remaining scope)

Automated pattern detection algorithm not built. Infrastructure (`get_build_history`, `get_cross_run_analysis`, `cross-run-analyzer.ts`) is in place; surfacing high-frequency agent sequences as candidates for new flow variants or principle suggestions remains.

---

### Tier 5 — Evaluation & Testing

#### 22. Deterministic Agent Evaluation (expand scope)

Current fixture coverage is limited to intent classification. Expand to capture golden input/output pairs from other agent types and produce a broader regression suite for agent behavior.

#### 24. Eval Scenario Library

Purpose-built seed repositories paired with task scenarios and ground-truth test suites. Three-tier grader stack (structural, behavioral, semantic). Allows proactive benchmarking — not just golden-fixture regression.

---

### Tier 6 — Future Consideration

#### 25. Session-Start Documentation Health Check

On session start, surface a brief advisory when any `CLAUDE.md` has a low freshness confidence score. Quality scores across completeness, freshness, specificity, and coverage.

#### 26. Test Coverage Mapping

Augment the KG's static import-based coverage inference with actual runtime coverage data from the test runner. More accurate and catches transitive dependencies the static view misses.

#### 27. Hot-File Caution for Implementors

Inject a caution note when an implementor edits a file modified across many recent builds. Currently only partial: hotspot data is available in `get_file_context` output but is not injected into engineer spawn prompts.

#### 28. Idea-to-Spec Flow

A flow that takes a vague idea and drives it through structured clarification into a concrete spec. Runs conversational research, surfaces assumptions, asks clarifying questions, and produces a written spec as output.

---

## Archived

These items are obsolete and will not be built.

- **8 Flow Extension and Typed Ports** — Flow YAML is gone. Extension and typing as concepts no longer apply.
- **15 Flows That Adapt Mid-Execution** — Absorbed into agent teams lead decisions. The team lead reads wave N artifacts and decides what to spawn for wave N+1 natively.
- **21 Compaction Nudge as a Flow Concern** — Platform limitation; Claude Code doesn't expose a compaction hook with enough fidelity to make this tractable at the flow level.
- **23 Fragment-Level Testing** — Fragments were parser internals in the flow YAML system. That system is gone.
