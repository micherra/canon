# Supervised Build Quality — Direction Document

## Context

Canon currently runs supervised builds where the orchestrator pauses at HITL gates for human approval. After evaluating a full "dark factory" (lights-out autonomous) proposal, we decided:

- **HITL gates are features, not friction.** For a solo developer, the gates cost ~30 seconds but catch wrong assumptions that automated verification can't.
- **The system validates itself** (Canon reviews Canon's work). The human gate is the only truly independent check.
- **ROI is negative** for removing gates — enormous build investment to save trivial human time.

**Decision**: Instead of removing the human, invest in making the human's time at each gate more productive and the agent work between gates faster and better.

## What Shipped (Epics 1 + 2)

From the original dark factory proposal, two capabilities were merged (PR #232):

### Auto-Escalation (Epic 2) — Full implementation

`get_next_escalation_strategy` MCP tool. Replaces immediate HITL on agent failure with a structured cascade:

| Priority | Strategy | When |
|----------|----------|------|
| 1 | Add domain primer | Failure in unfamiliar area |
| 2 | Increase token budget | Agent ran out of turns |
| 3 | Escalate model | Running on sonnet, failure looks capability-limited |
| 4 | Narrow scope | Task too broad, partial progress exists |
| 5 | HITL | All strategies exhausted |

2-minute cumulative timeout. Per-flow config allows skipping strategies. State persisted to execution store.

### Confidence-Gated Auto-Approval (Epic 1) — Neutered implementation

`compute_autonomy_tier` MCP tool exists but the protocol restricts it:

- **Plan approval and initial review verdict are ALWAYS mandatory** regardless of tier
- Only low-value gates are skippable: build-step checkpoints, WARNING close-out, CLEAN re-review after fix
- Fail-safe: defaults to supervised on any signal-gathering error

## What Shipped: Epic 6 — Feed-Forward Enrichment (PR #239)

Cross-session error+fix index and pitfall enrichment. Before agent spawns, the orchestrator queries build history and injects context:

- **Before architect**: common failures in touched files → "known pitfalls"
- **Before engineer**: previous fix attempts in same area → "prior approaches"
- **Before reviewer**: principle violation history for files → "watch areas"

`error_fixes` table in execution store, populated from `write_implementation_summary`, queried via `get_context`.

### Epic 6 — remaining (not yet built)

- Auto-promotion: convention → strong-opinion when compliance > 95% across 5+ builds
- Auto-demotion: archive principles with 0 violations across 20+ builds
- Auto-apply policy config: `auto` | `suggest` | `off` (per project)

## What Shipped: Hooks & Confidence Wave (PRs #245–#261)

Between May 24–26, a concentrated wave shipped the top-priority roadmap items plus foundational infrastructure:

- **Tool-loop detection + spawn watchdog** (PR #245) — Thread 3 top items. PostToolUse fingerprinting and wall-clock spawn monitoring.
- **Shared hook library** (PR #248) — `hooks/lib/canon-hook-lib.sh` extracted from 5+ hooks. Foundation for all subsequent hook work.
- **DAG dispatch guard** (PR #253) — Advisory hook warns on raw `Agent` spawns during DAG execution, enforcing `TeamCreate`/`TaskCreate`.
- **Holistic confidence scoring** (PR #259) — Shared `ConfidenceScore` schema, `computeConfidence()` engine, review + drift adapters. Covers Thread 2 (confidence per violation, confidence decay) and Thread 4 (composite health score).
- **PostCompact narrative capture** (PR #261) — Thread 3 item. PostCompact hook preserves compaction summaries in workspace journal.
- **Hook hardening** (PRs #254, #255, #257, #260) — SIGPIPE fixes, session-start guards, shared test helpers, verify ghost state handling.
- **Dead-code cleanup** (PRs #252, #256, #258) — Drift violation fixes, dead workspace dirs, doc corrections.

## Supervised Build Quality — Feature Backlog

Three threads for making supervised builds faster and higher quality. Features are harvested from prior roadmap docs and prioritized by leverage.

### Thread 1: Fewer Review-Fix Loops

The biggest time sink. If the engineer gets it right first pass, you skip 1-2 full review cycles.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| ~~**Feed-forward enrichment** (Epic 6)~~ | ~~Medium~~ | ~~Very high~~ | Shipped (PR #239) |
| ~~**Cross-session error + fix index**~~ | ~~Medium~~ | ~~High~~ | Shipped (PR #239) |
| **Short-term area memory** | Small | High | Compact observations attached to subsystems with 7-day expiry. Next agent in same area gets them pre-injected. |
| **Hot-file caution for engineers** | Small | Medium | Inject a caution note when an engineer edits a file modified across many recent builds. Hotspot data exists in `get_file_context` — just needs injection into engineer spawn prompts. |
| **Outdated violation detection** | Medium | Medium | Track which diff lines each violation was pinned to. On re-review, violations on unchanged lines persist; violations on changed lines are marked "outdated." Stops reviewers from re-flagging fixed code. |

### Thread 2: Better HITL Presentations

Make each gate decision faster and more confident.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| ~~**Confidence per violation**~~ | ~~Small~~ | ~~High~~ | Shipped (PR #259). Shared `ConfidenceScore` schema + `computeConfidence()` engine. `review-confidence-adapter` scores each violation. |
| ~~**Confidence decay for drift**~~ | ~~Medium~~ | ~~Medium~~ | Shipped (PR #259). `drift-confidence-adapter` decays confidence by commits-since-review. `get_drift_report` sorts by staleness. |
| **GitHub-linkable review output** | Small | Medium | Review output includes clickable GitHub line links (`/blob/[sha]/path#L42-L48`). Useful when posting PR comments or sharing findings. |

### Thread 3: Faster Agent Turns

Context gathering burns the most agent turns. Reduce wasted work.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| ~~**Tool-level loop detection**~~ | ~~Small~~ | ~~High~~ | Shipped (PR #245). `tool-loop-detector.sh` PostToolUse hook with fingerprinting + exit code 2 → HITL. |
| ~~**In-flight spawn watchdog**~~ | ~~Small~~ | ~~High~~ | Shipped (PR #245). `spawn-timeout-watchdog.sh` tracks wall-clock per spawn, 20-min default threshold. |
| ~~**PostCompact narrative capture**~~ | ~~Tiny~~ | ~~Medium~~ | Shipped (PR #261). PostCompact hook appends compaction summary to workspace journal. |
| **Skill effectiveness tracking** | Medium | Medium | Learner analyzes journal outcomes to recommend: primers that help, `maxTurns` adjustments, skills that need updating. Requires extending `FlowRunEntry` with domain skill counts. |
| **Effort budgets** | Medium | Medium | Maximum tool calls per state, wall-clock duration limits, max agent spawns per flow. "Focus and wrap up" note injected when approaching limit; pause for approval when hit. |

### Thread 4: Codebase & Artifact Hygiene

Canon's own documentation and artifacts accumulate drift. Eat your own dogfood.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| **Wiki-lint over Canon's own artifacts** | Medium | High | Lint pass over contradictions between CLAUDE.md files, orphan principles with no usages, stale plans referencing renamed files, principles lacking backing examples. Canon lints code but not its own meta-layer. |
| ~~**Composite health score**~~ | ~~Small~~ | ~~High~~ | Shipped (PR #259). `computeConfidence()` engine with shared `ConfidenceScore` schema. Drift report integrates confidence decay. |
| **Proactive doc gap detection** | Small | Medium | Before classifying a diff, scribe scans for directories that contain source files but no CLAUDE.md. Finds gaps that passive diff-watching never catches. |
| ~~**Documentation staleness in drift reports**~~ | ~~Medium~~ | ~~Medium~~ | Shipped (branch `canon/address-learner-watchzzz1-scribe-scope-gap-for-human-facing-docs-with`). `doc_freshness` dimension in `get_drift_report`: `DocFreshness[]` per direction doc with `commits_since_sync` + decaying `ConfidenceAnnotation`, sorted by staleness descending. Scribe also gained elective `docs/*.md` factual-sync in Step 5b (prevention half, addresses `watch_ZZZ1`). |
| **Repo-level `.canon/log.md`** | Tiny | Medium | Global timeline of flow completions, principle additions, and lint passes. Single append at `complete_flow`. Grep-parseable `## [YYYY-MM-DD] type | title` prefix. |
| **Consolidate `write_*` → `write_artifact`** | Small | Low | 5 individual write tools still individually registered. One `write_artifact({ type, workspace, data })` reduces MCP surface. |

### Thread 5: Flow Inputs & Exploration

Make Canon smarter about what goes into builds, not just what comes out.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| **Smarter scribe spawn decisions** | Small | Medium | Pre-classify the diff for signals that reliably warrant doc updates (exported signature changes, new routes, schema changes). Scribe focuses judgment on boundary cases. |
| **Static security pre-filter** | Small | Medium | Cheap regex checks (`eval`, SQL concatenation, common secret formats) give the security agent a pre-filtered candidate list instead of starting from scratch. |
| **Idea-to-spec flow** | Medium | Medium | Takes a vague idea through structured clarification into a concrete spec. Conversational research, surface assumptions, clarifying questions, written spec as output. PM refine skill partially covers this; full explore→spec pipeline closes the loop. |
| **Compounding exploration** | Tiny | Low | Scribe convention that promotes notable explore findings into project-level `docs/notes/`. Explorations compound over time instead of evaporating. |
| **Explicit code-to-docs mapping** | Small | Low | Project-local config declaring which source directories are documented by which CLAUDE.md files. Eliminates scribe guesswork. |

### Not Doing

These were evaluated and explicitly rejected:

- **Scheduled builds via CronCreate** — Infrastructure reinvention. GitHub Actions + existing monitoring tools do this better.
- **Event-driven triggers (RemoteTrigger)** — Same reasoning. External shim complexity for a solo dev project.
- **Streaming observability pipeline** — JSONL + existing tooling is sufficient. No custom dashboard.
- **Progressive trust model** — Interesting but premature. Need 50+ builds of data before trust scores are meaningful. Revisit when build history is deep enough.
- **Autonomous PR lifecycle** — Removes the human from post-ship. The value of review comments is high; auto-responding risks missing nuance.
- **Recursive agent spawning** — Research shows 37% of multi-agent failures are coordination failures. Canon's flat orchestrator-worker hierarchy is correct.
- **Design-pattern/anti-pattern labels in KG** — Academic labeling (God Object, Singleton, etc.) with low practical impact for a solo dev project. The KG already exposes hub scores and cycles.
- **Duplicate-block detection** — AST shingling is a large build for medium signal. Reviewer and learner catch copy-paste issues well enough.
- **Graph-structured agent memory** — Premature. Requires memory architecture (P5) that isn't needed yet. Current `MEMORY.md` approach is sufficient.
- **Memory decay / Ebbinghaus model** — No pain point driving this. Memory isn't growing fast enough to need automated pruning.
- **4-tier memory hierarchy** — Formalization without a clear need. The tiers exist informally and work fine.
- **Parallel multi-perspective review** — Team dispatch already covers file-partition fan-out. Perspective-based split (compliance vs bugs vs security) adds coordination cost for marginal gain.
- **Inline diff view (Shiki)** — The HTML renderer already shows violations per file. A line-level diff viewer is a large UI build for incremental improvement.
- **Test coverage mapping** — Depends on Istanbul/c8 being configured in the project. Revisit if coverage tooling is set up.
- **Expanded agent evals / eval scenario library** — Large scope. Current intent-classification evals are sufficient. Revisit when agent behavior regressions become a problem.
- **KG query traceability log** — Useful in theory for tuning retrieval, but no pain point today.

## Recommended Build Order

| Phase | What | Rationale |
|-------|------|-----------|
| ~~**Done**~~ | ~~Tool-loop detection + spawn watchdog~~ | Shipped PR #245. |
| ~~**Done**~~ | ~~Confidence scoring + drift decay + composite health~~ | Shipped PR #259. |
| ~~**Done**~~ | ~~PostCompact narrative capture~~ | Shipped PR #261. |
| **Next** | Wiki-lint + doc gap detection | Canon eating its own dogfood. Composite health score is now available to surface drift; wiki-lint closes the loop on artifact contradictions. |
| **Next** | GitHub-linkable review output | Last remaining Thread 2 item. Small build, immediate value for PR workflows. |
| **Then** | Short-term area memory + hot-file caution | Compound context for engineers. Data exists in `get_file_context`, needs injection into spawn prompts. |
| **Then** | Effort budgets + skill effectiveness tracking | Last Thread 3 items. Cap runaway agent turns and learn which primers/skills help. |
| **Later** | Outdated violation detection, smarter scribe, idea-to-spec | Compound value features that improve over time. |
| **Remaining Epic 6** | Auto-promotion/demotion thresholds, auto-apply policy | Needs sufficient build history to be meaningful. |
