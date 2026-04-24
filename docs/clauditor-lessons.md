# Clauditor Lessons — Canon Feature Planning

This document captures six features from the clauditor project that Canon could adopt. Clauditor is a Claude Code hook layer built for resilience, observability, and self-correction across long-running agentic sessions. Each item below is a candidate for Canon adoption, adapted to fit Canon's orchestration model.

Use this doc as a discussion scaffold. The architect's assessment sections below reflect an initial analysis pass — use them to guide sequencing decisions and flag implementation concerns before building.

---

## 1. PostCompact Narrative Capture

**What it does**

When Claude Code performs a context compaction, it generates a `compact_summary` describing what was pruned. A `PostCompact` hook intercepts this summary and appends it to the active workspace's journal, so agent reasoning — goals, decisions, blockers — is not lost when the conversation window resets.

**What Canon currently has**

Canon has no `PostCompact` handler. The workspace journal (`journal.json`) is updated by `log_step` calls during orchestration, but there is no hook that fires on compaction events. Agent reasoning accumulated during a long session can silently disappear at compaction boundaries.

**Proposed implementation approach**

- Register a `PostCompact` hook in `.claude/settings.json` pointing to a script (e.g., `hooks/post-compact.sh`).
- The script reads the `compact_summary` from the hook payload and appends a timestamped entry to the active workspace's journal.
- If no active workspace is found, write to a fallback log at `.canon/compact-history.log`.
- The scribe agent should be made aware of the compact history entry so it can incorporate it into context-sync summaries.

**Architect's assessment**

Do this first. It is the highest-value item in the list for the lowest implementation cost — roughly 50 lines of shell script plus a `hooks.json` entry.

The pattern is proven: Canon already has `compaction-check.sh` as a `PostToolUse` hook, so the infrastructure and conventions are in place. The downstream consumer also exists — the scribe already reads workspace state — so the captured narrative flows naturally into context-sync without any additional wiring.

The one thing to verify before building: confirm that Claude Code actually exposes `PostCompact` as a named hook event. It is a newer hook point and may not appear in all versions. Worth a quick check against the current Claude Code hook documentation before committing the `settings.json` entry.

ADR-001 (SQLite store) is now built, so the journal and orchestration DB are available as write targets. The hook can write directly to the workspace journal or the orchestration DB events table.

**Open questions / notes**

- Confirm `PostCompact` hook event is available in the current Claude Code release.
- Decide how the scribe agent signals that it has consumed a compact entry (to avoid re-processing on the next sync).
- Consider whether the fallback `.canon/compact-history.log` should roll over by date or by session to avoid unbounded growth.

---

## 2. Cross-Session Error + Fix Index

**What it does**

Maintains a `.canon/error-index.json` keyed by `(project, command, error-fingerprint)`. When a command fails, the failure is recorded. If a similar command succeeds within 60 seconds of the failure (proximity heuristic), the succeeding command is inferred as the fix and stored alongside the error. A `PreToolUse` hook checks this index before a fixer agent runs and injects any known fix as context, reducing repeated diagnosis time.

**What Canon currently has**

Canon has per-session retry budgets and fixer agents that diagnose failures from scratch each time. There is no persistent error memory across sessions or builds. The fixer agent re-reads logs and re-reasons through errors it may have seen and resolved before.

**Proposed implementation approach**

- On every `Bash` tool failure, a `PostToolUse` hook writes the error fingerprint (tool name + exit code + stderr hash) to `.canon/error-index.json`.
- On the next succeeding `Bash` call within 60 seconds, the hook updates the index entry with the succeeding command as the inferred fix.
- A `PreToolUse` hook (fires before the fixer agent's first tool call) checks the index and injects a `known_fix_hint` into the agent's environment or a pre-prompt file the fixer reads.
- The index is append-only and keyed by a stable fingerprint so it survives across worktrees and sessions.

**Architect's assessment**

Design now, but do not build the JSON-file version. This feature has the right intent but the proposed implementation has two significant problems that make it worth waiting for the right infrastructure.

The 60-second proximity heuristic is fragile. It does not account for the time an agent spends reasoning between a failure and a fix attempt — that gap can easily exceed a minute in complex fixer runs. The result is a low-recall index that misses many valid fix associations. A better data source is already coming: `write_implementation_summary` (ADR-010) explicitly records what was fixed and how. Mining that instead of inferring from temporal proximity produces a much higher-quality signal.

The `PreToolUse` hook injection also bypasses the structured prompt assembly pipeline (ADR-006, now built). Error history injection belongs in the lead's context enrichment before spawning agents — via MCP tool calls (e.g., `get_context`) — not as a side-channel hook. Adding it outside the MCP tool path creates a second code path for context injection that will be difficult to reason about or audit.

ADR-001 (SQLite store) and ADR-010 (structured output contracts) are now built. An `error_fixes` table in the orchestration DB is a natural fit, and `write_implementation_summary` can serve as the fix-recording mechanism.

**Open questions / notes**

- Draft the `error_fixes` table schema for the orchestration DB.
- Determine how error history surfaces to agents — likely via `get_context` or a new MCP tool.
- Decide whether `write_implementation_summary` (ADR-010) is the canonical fix-recording mechanism, or whether hooks supplement it for cases the implementor summary misses (e.g., orchestrator-level retries).

---

## 3. Tool-Level Loop Detection

**What it does**

A `PostToolUse` hook fingerprints each tool call by hashing `(tool_name + input + output)`. If 3 consecutive turns produce identical fingerprints, the hook exits with code 2, blocking further tool use and surfacing the loop to the orchestrator or user. This catches agents that are silently repeating the same ineffective action.

**What Canon currently has**

Canon has orchestrator-level retry budgets (e.g., a fixer agent retries up to N times before the orchestrator escalates). But retry counting is coarse-grained and does not detect identical-action loops within a single agent invocation. An agent can issue the same failing tool call multiple times within its budget without triggering any intervention.

**Proposed implementation approach**

- Register a `PostToolUse` hook that maintains a rolling window of the last 3 tool call fingerprints in a per-session scratch file (e.g., `.canon/loop-detector.json`).
- On each tool call, compute `sha256(tool_name + JSON(input) + JSON(output))` and append to the window.
- If all 3 entries in the window are identical, exit with code 2 and write a human-readable message to stderr describing the repeated call.
- The orchestrator's error handler should recognize the loop-detection exit code and surface it as a `HITL` breakpoint rather than a retryable error.
- Clear the window when a non-identical call occurs or when a new workspace is initialized.

**Architect's assessment**

Second priority, close behind Feature 1. This addresses a real and common failure mode — an agent silently spinning on a broken action — and the hook architecture is a clean fit. The fingerprint includes output, which is the important detail: identical `(tool + input + output)` three times means the agent genuinely learned nothing from its own results. False positives should be rare.

Canon already uses exit code 2 in the destructive-guard hooks, so the exit-code convention is established. The loop detector slots into the same pattern.

One requirement that must be specified explicitly before building: the orchestrator's error handler needs to treat loop-detection exit code 2 as a HITL breakpoint, not a retryable error. The current error handler may not distinguish between these cases. This interaction — hook signals loop, orchestrator routes to HITL rather than retry — needs a spec or ADR note before implementation, or we will get the wrong behavior by default.

The hook also sits below the orchestrator, inside the Claude Code agent runtime. That is actually the right intervention point for this problem: loop detection belongs at the tool layer, not the orchestration layer.

**Open questions / notes**

- Specify the error handler routing rule: exit code 2 from loop-detection hook → HITL breakpoint, not retry.
- Decide the per-session scratch file location. `.canon/loop-detector.json` works but should be scoped to a worktree or session to avoid cross-agent interference when running parallel implementors.
- Tune the window size. Three consecutive identical calls is the starting proposal — consider whether 2 is too aggressive or whether 4 is needed for agents with legitimate retry patterns.

---

## 4. Compaction Nudge Heuristic

**What it does**

Detect when a session has run for many steps without a context sync and surface a nudge suggesting compaction. A simpler proxy for clauditor's waste factor metric, which measures how much of an agent's context window is consumed by stale or redundant content.

**What Canon currently has**

Canon has a context-sync step in some runbooks (driven by the scribe agent) but no mechanism to detect when compaction would be beneficial. Long sessions can degrade context quality without any visible signal.

**Proposed implementation approach**

In v2.1's agent-teams architecture, `drive_flow` and `board.json` are being replaced. The nudge becomes a session-level concern rather than a flow-state concern:

- Track step count in the workspace journal. After each `log_step` completion, check total completed steps since last context-sync (or session start).
- If count exceeds the threshold (configurable in `.canon/config.json`), the lead surfaces a plain-language nudge: "This session has been running for a while — you may want to compact before continuing."
- Do not block — the nudge is advisory.
- Consider lowering the threshold for multi-wave builds, which accumulate more state per step.

**Architect's assessment**

The problem is real — sessions can drift into degraded context quality without any visible signal. ADR-003 (diagnostics, now built) provides the event infrastructure to answer "how many steps since last sync?" via a `diagnose` query. The nudge can be implemented as:

1. A `diagnose` tool query that the lead checks periodically (simplest)
2. A lead-level heuristic that checks the journal step count between agent spawns
3. The planner can include context-sync steps in synthesized runbooks at appropriate intervals

Option 3 is the cleanest — the planner's synthesis skill already decides step sequencing, and it can insert context-sync steps for longer runbooks.

**Open questions / notes**

- Determine the right threshold per build complexity (multi-wave builds likely need a lower threshold than single-task builds).
- Evaluate whether a `diagnose` tool query is sufficient to surface the signal without any orchestration changes.

---

## 5. Workflow Pattern Mining

**What it does**

Extends `learner` to mine execution history across builds, looking for repeated agent sequences (e.g., implement → fail → fix → re-test appears in 70% of builds). High-frequency sequences can surface as runbook synthesis refinements or new principle suggestions, feeding back into Canon's design over time.

**What Canon currently has**

`learner` currently performs pattern analysis on a single session or on principles, but does not aggregate across the full workspace history. Each build's journal is self-contained and there is no cross-build analysis step. Patterns that repeat across many builds are invisible to the pipeline.

**Proposed implementation approach**

- Add a `mine_patterns` task to `learner`'s skill definition, triggered either on demand or after a configurable number of builds.
- ADR-001 (SQLite store) is now built. The learner queries the orchestration DB's journal and metrics tables across workspaces to extract agent-type sequences per build and compute frequency distributions.
- Sequences above a frequency threshold (e.g., appearing in >30% of builds) are written to `.canon/pattern-report.md` with occurrence counts and example build IDs.
- The learner can optionally propose a principle draft or a synthesis vocabulary refinement, tagged for human review before adoption.
- Gate the mining task behind a flag so it does not run on every build (it is a batch analysis, not a hot path).

**Architect's assessment**

Defer until ADR-016 is complete and sufficient build history has accumulated. The `learner` extension is architecturally clean — it fits naturally alongside ADR-016's auto-triggered learning.

ADR-001 (SQLite) is now built, so cross-build pattern analysis is a SQL aggregation query on the orchestration DB. No JSONL parsing needed. The remaining blocker is volume: most Canon projects do not yet have enough build history to make pattern mining meaningful. The feature pays off after sustained use, and that use has not accumulated yet.

**Open questions / notes**

- Define the minimum build count threshold before mining is triggered (to avoid noisy results on low-volume projects).
- Determine what agent-sequence granularity is most useful: agent-type sequences, step sequences, or both?
- Once ADR-016's auto-trigger mechanism is designed, decide whether pattern mining runs on a schedule, on demand, or after a threshold event count.

---

## 6. Hot-File History Injection

**What it does**

Extends `principle-inject.sh` to check `.canon/file-history.json` (a log of which files were modified in each build) and inject a caution note into the implementor's context when it is about to edit a file that has been modified in several previous builds. The note surfaces the file's modification frequency and the builds that changed it, alerting the implementor to tread carefully on a high-churn file.

**What Canon currently has**

`principle-inject.sh` injects relevant Canon principles into agent prompts based on task domain. It has no awareness of file-level change history. Implementors editing hot files receive no additional context about the file's churn pattern or the risk of repeated modification.

**Proposed implementation approach**

- Maintain `.canon/file-history.json` as a map from file path to a list of build IDs in which that file was modified. Update this file via a `PostToolUse` hook on `Write` and `Edit` calls.
- Extend `principle-inject.sh` to accept the list of files an implementor will touch (passed from the orchestrator's spawn prompt) and check each against `file-history.json`.
- If a file appears in more than N previous builds (e.g., N=3), append a caution block to the injected context: file path, modification count, and the most recent build IDs.
- The caution is informational — it does not block the implementor. The intent is to prompt extra care or a note in the implementation log.
- Keep the threshold configurable so teams with fast-moving codebases can tune sensitivity.

**Architect's assessment**

Low priority. The core signal — file modification frequency — is not clearly actionable for agents, and the implementation has latency concerns that get worse over time.

The fundamental problem with modification frequency as a signal is that high-churn files are often central modules that legitimately change often. The caution would fire most aggressively on exactly the files implementors need to modify most confidently and frequently. That is the opposite of useful. Frequency is a structural indicator, not a risk indicator.

`get_file_context` (blast radius, import/export analysis, graph metrics) provides more structurally meaningful information about why a file is sensitive — it tells the implementor about downstream impact rather than just historical edit count. That context is more likely to prompt the right kind of care.

The latency concern is also real: a `PostToolUse` hook on every `Write` and `Edit` call reads and writes `.canon/file-history.json` on each modification. As the file grows across builds, this overhead compounds. Adding a new `.canon/*.json` file is architecturally regressive given that ADR-001's SQLite store is now built.

If this feature is revisited, evaluate whether `get_file_context` coverage already renders it unnecessary. If it does not, the SQLite version would be a straightforward query on the events table in the orchestration DB.

**Open questions / notes**

- Evaluate `get_file_context` coverage first — it may already surface the structural context that makes frequency-based caution redundant.
- If the feature survives that evaluation, design for ADR-001's SQLite events table from the start.
- Consider whether the signal improves if scoped to modification frequency within a narrow time window (e.g., files touched in the last 10 builds) rather than all-time.

---

## Priority / Sequencing

The six features split into two natural categories:

**Runtime resilience** (Features 1, 3, 4) — provide value on every run, starting from the first build after they are deployed.

**Cross-session learning** (Features 2, 5, 6) — compound over time as data accumulates. Their value is low early and grows with usage. ADR-001's SQLite store is now built, so these features should use the orchestration DB directly — no new `.canon/*.json` files.

The two features that avoid the JSON-file problem — Features 1 and 3 — are the ones to ship first.

### Recommended order

**1. PostCompact Narrative Capture — Build now**

Highest value-to-complexity ratio in the list. Proven hook pattern, existing downstream consumer, ~50 lines of implementation. The one pre-condition is confirming that `PostCompact` is a named hook event in the current Claude Code release.

**2. Tool-Level Loop Detection — Build now or soon**

Addresses a real failure mode with a clean architecture. One explicit requirement before building: specify the orchestrator error-handler routing rule so that exit code 2 from this hook surfaces as a HITL breakpoint rather than a retryable error. Once that interaction is documented, implementation is straightforward.

**3. Cross-Session Error + Fix Index — Build with ADR-010**

ADR-001 (SQLite) and ADR-006/008 (context assembly) are now built. The infrastructure is ready. Draft the `error_fixes` table schema for the orchestration DB and use `write_implementation_summary` (ADR-010) as the fix-recording mechanism rather than proximity inference.

**4. Compaction Nudge Heuristic — Redesign as a planner/session concern**

The problem is real but the original proposal targeted `drive_flow` and flow-level conditional states (ADR-012), both of which are being replaced by agent teams. Redesign as either a planner synthesis concern (insert context-sync steps in longer runbooks) or a session-level journal query.

**5. Workflow Pattern Mining — Build after ADR-016 + sufficient history**

Clean architectural fit for `learner`. ADR-001 (SQLite) is now built, so pattern mining is a SQL query on the orchestration DB. The remaining blocker is sufficient build history. Design the `mine_patterns` task as a SQL-backed query triggered by ADR-016's auto-learn gate.

**6. Hot-File History Injection — Revisit after evaluating `get_file_context` coverage**

The signal (modification frequency) may not be actionable, and `get_file_context` may already cover the structural concern this feature is trying to address. Evaluate that first. If a gap remains, use the orchestration DB directly.
