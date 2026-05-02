# Canon Roadmap

Planned and in-progress improvements to Canon. Items are organized by status: what has shipped, what is actively in progress, and what is planned for the future. Planned items earlier in the list are smaller, have fewer prerequisites, and are more likely to land sooner.

---

## Shipped

### Tier 0: Agent Teams Coordination Layer (v2.1a — April 2026)

The v2.1a soak period (2026-04-23 to 2026-04-30) validated the transition from Canon's legacy flow state machine to runbook-driven sequential orchestration. 20 real-use builds completed CLEAN. The soak evidence is in `docs/v2.1a-soak-period.md`.

**What shipped in v2.1a:**

- **Runbook synthesis** — the planner synthesizes a runbook from a canonical step vocabulary per build, replacing 10 hardcoded flow YAML files
- **Sequential subagent orchestration** — the orchestrator reads the approved runbook and spawns agents one at a time via the `Agent` tool; no state machine involved
- **Workspace + journal system** — `init_workspace`, `log_step`, `batch_log_steps`, `verify_completion` create and track per-build workspaces with artifact contracts
- **Knowledge graph** — `codebase_graph`, `graph_query`, `semantic_search`, `get_file_context`, `get_context` (composite) provide principle-grounded context for every agent spawn
- **58 principles** — rules, strong-opinions, and conventions covering architecture, testing, error handling, and more
- **Review + PR tools** — `write_review`, `store_pr_review`, `show_pr_impact`, `review_code`
- **Planner pre-build gate** — every build routes through the planner before a line of code is written; planner produces a planning brief and runbook
- **Requirements traceability** — three-level coverage chain: request → runbook (Requirement Coverage Map) → task plan (Brief Coverage) → implementation (Criteria Coverage)
- **Resolve agent skills (4-field preloader)** — `rules`, `references`, `primers`, `templates` frontmatter fields preloaded into every agent spawn via `resolve_agent_skills`
- **History tools** — `get_build_history`, `get_historical_artifacts`, `get_cross_run_analysis`
- **Transcript capture + agent metrics** — automatic capture via `logStep` integration, `store_summaries`, `record_agent_metrics`
- **12 hooks across 4 lifecycle events** — including the L4 workspace-check hook that blocks code edits when no active Canon workspace exists
- **Artifact writers + UI components** — PR review, codebase graph, file context renderers
- **Background janitor** — handles stale worktree pruning, workspace archival, database checkpointing

**Soak remediations resolved during v2.1a:** NF-3, NF-7, NF-8, NF-9, NF-10, NF-11, NF-12, NF-13, NF-14, NF-15, NF-16, NF-17, NF-18, v2_1b-10 (mandatory tail enforcement). See `docs/v2.1a-soak-period.md` for details.

---

## In Progress

### v2.1 Completion Work

**v2.1 is not done.** The soak period validated the transition — runbook-driven orchestration replacing the legacy flow state machine. But v2.1 is complete only when:

1. `CANON_AGENT_TEAMS_MODE` feature flag is removed entirely
2. Claude Code native teams (`TeamCreate`/`TaskCreate`/`TaskList`) are the only parallel execution path
3. All legacy code gated behind that flag is deleted

**What remains for v2.1 completion:**

#### v2.1b: Delete the legacy coordination layer

Remove everything that only existed to support the flow state machine. The code is live but unexercised in default mode (when `CANON_AGENT_TEAMS_MODE=on`, which is now the default operating mode post-soak).

Files and components to delete:

| Component | Files |
|-----------|-------|
| State machine runtime | `drive-flow.ts`, `drive-flow-helpers.ts`, `drive-flow-wave.ts`, `drive-flow-wave-lifecycle.ts` |
| 10 flow YAML files | `flows/fast-path.yaml`, `feature.yaml`, `refactor.yaml`, `migrate.yaml`, `test-gap.yaml`, `review-only.yaml`, `security-audit.yaml`, `epic.yaml`, `explore.yaml` + variants |
| 14 flow fragments | All files under `flows/fragments/` |
| Flow YAML runtime | Parser, validator, fragment inclusion system, transition-target matcher |
| Wave event plumbing | `inject_wave_event`, `resolve_wave_event`, flow event channel |
| Wave lifecycle functions | `createWaveWorktrees`, `mergeWaveResults`, `cleanupWorktrees` |
| Message channel MCP tools | `post_message`, `get_messages` |
| Consultation executor | `consultation-executor.ts`, `resolve_after_consultations` MCP tool |
| Competitive flows + debate protocol | All related tooling |
| `CANON_AGENT_TEAMS_MODE` feature flag | Remove the branch, delete the legacy path |

Expected outcome: 30–40% reduction in `mcp-server/src/features/orchestration/` by line count.

#### v2.1c: SubagentStop hook for architect

When the architect finishes, check for `task-dag.yaml` and inject a DAG summary into the orchestrator context. This closes the feedback loop so the orchestrator knows a DAG is present before the implement step begins.

#### v2.1d: Validate DAG parallel dispatch end-to-end

The DAG execution protocol is fully specified in CLAUDE.md: the architect produces `task-dag.yaml`, the orchestrator detects it, calls `TeamCreate`/`TaskCreate`/`TaskList`, spawns N worker engineers, and merges results. The `dag-validator.ts` utility exists in `mcp-server/src/shared/lib/`. However, no build has ever triggered this path — all 20 soak runs were small/medium scope with single-task implementations. The protocol is specified but unexercised.

To validate: run any build with a design step and 2+ separable implementation tasks (e.g., a feature touching both a data layer and a UI layer). The architect should produce a `task-dag.yaml` with two root tasks. The orchestrator should create a team, spawn two workers, and merge results. This path is a prerequisite to claiming DAG parallel dispatch as shipped.

#### Cleanup

- Remove legacy `mcp-server/src/tools/` directory (orphaned pre-migration copies)
- Update principle count in CLAUDE.md from 54 to 58 (actual count)
- Remove the `fast-path` reference from the Flow Selection table in CLAUDE.md

---

## Planned

The items below are independent of the coordination layer. Each is scoped to principles, drift, documentation, agent intelligence, or evaluation. None requires the legacy flow state machine — all work against the v2.1 runbook model.

---

### Tier 1: Quick Wins

#### 1. Preserve Agent Reasoning Across Context Compaction

**What:** When Claude Code compacts its context window during a long session, Canon captures the compaction summary and appends it to the active workspace's progress log. Contingent on Claude Code exposing a compaction hook event — if that hook is unavailable, a fallback heuristic based on session length and tool-call volume gives an approximate signal.

**Why:** Long-running sessions accumulate goals, decisions, and blockers in the conversation. When compaction fires, that reasoning silently disappears. Capturing it means the scribe can still see what the agents were thinking when it syncs documentation at the end of a build.

#### 2. Tool-Level Loop Detection

**What:** Canon already detects stuck states (an agent reporting the same status across iterations without progress). This adds a finer check at the tool-call level: when an agent repeats the same tool with the same inputs three times in a row within a single turn, Canon pauses and surfaces the loop.

**Why:** The existing stuck detector catches loops that span iterations but misses tight within-agent loops — an agent retrying the same failing command dozens of times inside one turn. Catching identical-call loops earlier saves effort and gets things unstuck before the iteration-level detector fires.

#### 3. In-Flight Spawn Watchdog

**What:** Canon will track a start timestamp for every agent spawn and check it on each orchestrator poll. When a single spawn exceeds a configurable wall-clock threshold (default: 20 minutes for engineers, shorter for other roles), Canon pauses and surfaces the long-running agent with the option to wait, cancel, or intervene.

**Why:** While an agent is mid-spawn, nothing updates, so a single engineer can spin for an hour without any detector noticing. A per-spawn wall-clock heartbeat closes the gap between "agent started" and "agent reported."

#### 4. Documentation Sync on All Build Sizes

**What:** The scribe will run after small builds (simple changes and bug fixes), not just medium and large ones. It will skip quickly when there are no contract-level changes.

**Why:** Most bug fixes and small improvements currently skip the scribe entirely. Documentation drifts not because the scribe fails but because it never runs on small changes. Cheap skip logic means adding the step costs almost nothing when there is nothing to update.

#### 5. Proactive Documentation Gap Detection

**What:** Before classifying a diff, the scribe will scan the project for directories that contain several source files but no `CLAUDE.md`. When it finds a gap, it creates a stub so the directory has baseline documentation going forward.

**Why:** The scribe currently only reacts to diffs. Proactive discovery closes documentation gaps that passive diff-watching will never catch.

#### 6. Explicit Code-to-Docs Mapping

**What:** A project-local configuration file where you declare which source directories are documented by which `CLAUDE.md` files. The scribe reads this mapping to know exactly which docs to update when a given area changes.

**Why:** Without an explicit mapping, the scribe has to guess which docs are affected by a change. Telling it directly — "changes under `src/orchestration/` affect these files" — eliminates the guesswork and makes sync behavior predictable.

#### 7. Smarter Scribe Spawn Decisions

**What:** Before spawning the scribe, Canon will scan the diff for signals that almost always warrant a doc update (exported signature changes, new routes, schema changes, new dependencies, new files). Obvious cases are pre-classified; the scribe only reasons about boundary cases.

**Why:** The scribe's hardest calls are "is this contract-level or internal?" Pre-classifying obvious cases means the scribe runs when it should and focuses its judgment on genuinely tricky ones.

---

### Tier 2: Infrastructure Refinements

#### 9. Worktree Sandboxing and Audit Log

**What:** Canon already auto-approves a filtered allowlist of tools when an agent runs inside an isolated worktree. Two gaps remain: hard path enforcement that denies writes outside the worktree, and an audit log recording every auto-approved action for after-the-fact review.

**Why:** The auto-approval allowlist constrains which tools agents can use, but it does not bound where those tools can write. Hard path enforcement turns the worktree into a real sandbox. The audit log makes "what did the agents actually do while I wasn't watching?" answerable.

#### 10. Durable Agent Performance Metrics

**What:** Agents already record per-run metrics (tool call counts, orientation calls, turns) into their workspace. This adds two pieces: a rollup into a project-level store that survives workspace cleanup, and a query tool to see efficiency trends across builds.

**Why:** Today those metrics are trapped in per-workspace databases that get pruned. You cannot compare across runs or track whether agents are getting faster and more focused after tuning prompts or context injection.

#### 11. Finish Architectural Boundary Cleanup

**What:** Resolve the last known internal coupling violations between Canon's orchestration layer and its storage layers, and tighten the boundaries around the file-context query path.

**Why:** Canon enforces architectural boundaries in CI, and the two known exceptions are tracked as technical debt. Cleaning them up removes the exception list and simplifies the dependency graph.

---

### Tier 3: Intelligence and Observability

#### 12. Confidence Decay for Drift Reports

**What:** Drift reports will replace binary pass/fail with a confidence score between 0.0 and 1.0. The score decays as code changes accumulate without a re-review — more for bigger changes, less for smaller ones.

**Why:** Binary compliance is misleading. A file reviewed three months and 40 commits ago is technically "passing" but practically stale. Confidence decay prioritizes review attention toward files that have drifted most since their last review.

#### 13. Hotspot and Co-Change-Aware Scribe

**What:** The scribe will receive signals from Canon's git intelligence layer about which files are hotspots (high churn and complexity) and which files frequently change together. Hotspots get extra documentation attention, and co-change partners that diverge trigger warnings.

**Why:** Canon already mines these signals from git history but nothing consumes them for documentation quality. High-churn files deserve thorough docs — they're where bugs cluster.

#### 14. Documentation Staleness in Drift Reports

**What:** Drift reports will include a documentation freshness dimension alongside principle compliance. Each `CLAUDE.md` gets a "commits since last sync" count and a confidence score that decays over time.

**Why:** Drift reports currently only cover principle compliance. A `CLAUDE.md` that has not been touched through 20 commits of changes to its directory is likely misleading every agent that reads it.

---

### Tier 4: Cross-Session Learning and History

#### 17. Expand Janitor Scope (Full Housekeeping Agent)

**What:** The basic janitor (worktree pruning, workspace archival, database checkpointing) shipped in soak run #4. The planned expansion adds the remaining housekeeping capabilities: extracting decision records from completed builds, trimming old transcripts, refreshing the knowledge graph, and triggering the learner when its gate opens.

**Why:** The shipped janitor covers the most common cleanup cases, but Canon's deeper housekeeping still runs inline at build completion (slowing builds as features accumulate) or depends on manual action. Expanding the janitor to own all housekeeping makes each build faster and removes the dependency on optional git hooks.

#### 18. Short-Term Memory for Recently-Touched Areas

**What:** When agents touch a subsystem, Canon captures compact factual observations — patterns observed, recent changes, known gotchas — and attaches them to that area of the codebase with a short expiry (default seven days). The next agent that works in the same area gets those observations pre-injected into its context.

**Why:** When you run three feature builds touching the same subsystem in a week, each researcher re-discovers the same architecture, each engineer re-learns the same patterns. Auto-expiring observations fill the gap between permanent static context and slow-cycle learning without the staleness risks of permanent storage.

#### 19. Cross-Session Error and Fix Memory

**What:** When an engineer summary records a fix for a specific kind of build or test failure, Canon remembers the association. The next time a fixer agent encounters a similar failure, the known fix is injected into its context as a starting hypothesis.

**Why:** Canon's fixer agents diagnose failures from scratch every time. There is no persistent memory across sessions, so the same error gets re-reasoned from first principles on every occurrence. Remembering past fixes means familiar errors get resolved immediately instead of re-investigated.

#### 20. Workflow Pattern Mining

**What:** The learner will analyze execution history across many builds to find repeated agent sequences — for example, "implement → fail → fix → re-test appears in 70% of feature builds." High-frequency patterns surface as candidates for new runbook variants or principle suggestions.

**Why:** Patterns that repeat across many builds are invisible to the current pipeline. If Canon keeps landing in the same fix loop for a certain class of task, that is a signal the runbook should include a pre-implementation verification step by default.

---

### Tier 5: Evaluation and Testing

#### 22. Deterministic Agent Evaluation

**What:** A framework for capturing "golden" input/output pairs from successful builds as evaluation fixtures, checked into git. A new command replays those fixtures through current agent definitions and diffs the structured outputs against the golden baseline.

**Why:** When you change an agent's instructions or tune the prompt pipeline, there is no baseline to compare against today. Fixtures turn "did this change help?" from guesswork into an actual diff, and they become a regression suite for agent behavior.

#### 24. Eval Scenario Library

**What:** A library of small purpose-built seed repositories paired with task scenarios and ground-truth test suites. Canon runs each scenario end-to-end and scores the results with a three-tier grader stack (structural, behavioral, and semantic). An A/B protocol lets you compare configurations head-to-head.

**Why:** Golden fixtures are reactive — you can only build them from builds that already succeeded. Eval scenarios are proactive: reproducible benchmarks with known-correct outcomes that let you measure whether a configuration change actually improves real results on realistic codebases, not just matches a past snapshot.

---

### Tier 6: Future Consideration

#### 25. Session-Start Documentation Health Check

**What:** On session start, Canon surfaces a brief advisory when any `CLAUDE.md` in the project has a low freshness confidence score. The same system gives each `CLAUDE.md` a quality score across completeness, freshness, specificity, and coverage.

**Why:** Documentation quality is currently invisible until someone reads a stale file and gets misled. A lightweight session-start signal turns that into a gentle nudge without blocking anything.

#### 26. Test Coverage Mapping

**What:** Canon's knowledge graph already infers which tests cover which files from static imports. This would augment that with actual runtime coverage data from your test runner.

**Why:** When an agent modifies `foo.ts`, knowing that `bar.test.ts` covers it means the agent can run exactly the relevant tests instead of the full suite. Runtime coverage is more accurate than import analysis and catches transitive dependencies the static view misses.

#### 27. Hot-File Caution for Engineers

**What:** When an engineer is about to edit a file that has been modified across many recent builds, Canon would inject a caution note naming the build history.

**Why:** Likely redundant — Canon's file-context tool already surfaces more structurally meaningful information (blast radius, import/export analysis, graph metrics). Worth evaluating whether a frequency signal adds anything actionable before building it.

#### 28. Idea-to-Spec Build

**What:** A new build type that takes a vague idea — "I want to rebuild notifications" or "something is off with the checkout funnel" — and drives it through structured clarification into a concrete spec you can feed back into a build. It runs conversational research, surfaces assumptions, asks clarifying questions, and produces a written spec as its output.

**Why:** Canon's existing builds all assume you already know what you want. An idea-to-spec build closes the gap so the handoff from "I have a rough idea" to "I am ready to build" is a Canon workflow instead of a manual conversation.

---

## Items Absorbed by v2.1 (Obsolete or Reframed)

These items from the original roadmap are closed out as part of the v2.1 coordination layer migration.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 8 | Flow Extension and Typed Ports | **Obsolete** | Flows are gone. Runbooks are synthesized per build from a canonical step vocabulary. Extension and typing move into the spawn-prompt assembly library and the runbook schema — no fragment composition or typed ports needed. |
| 15 | Flows That Adapt Mid-Execution | **Absorbed** | The native teams orchestrator (the team lead) reads wave N artifacts and decides which agents to spawn for wave N+1. Mid-run adaptation is how agent teams natively work. No state machine extension needed. |
| 16 | Effort Budgets on Flows | **Reframed** | Re-homes onto `TeammateIdle` / `SubagentStop` hooks and task-list metadata instead of flow-runtime counters. The concept survives; the flow-specific implementation is gone. |
| 21 | Compaction Nudge as a Flow Concern | **Reframed** | Becomes a task-list and session-level concern, not a flow-level one. Absorbed into Item 1 (Preserve Agent Reasoning Across Context Compaction) and session hooks. |
| 23 | Fragment-Level Testing | **Obsolete** | Fragments are gone with the state machine. The thing being tested no longer exists. |
