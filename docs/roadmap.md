# Upcoming on the Roadmap

Planned improvements to Canon, grouped by when you'll likely see them. Everything here is planned work — none of it is shipped yet. Items earlier in the list are smaller, have fewer prerequisites, and are more likely to land sooner.

---

## Tier 0: Coordination Layer Migration (new direction, 2026-04)

Claude Code shipped native agent teams (experimental, v2.1.32+). Experimental runs on 2026-04-10 confirmed that dynamic teammate spawning, per-teammate spawn prompts, a durable shared task list (`CLAUDE_CODE_TASK_LIST_ID`), and a full hook lifecycle (`SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`) are all reliable. That collapses the reason Canon's custom coordination layer exists, and reframes several items further down the list.

Authoritative plan: `docs/agent-teams-migration-plan.md`. Phase 1 work tracked on branch `canon/agent-teams-phase-1`.

### 0.1 Replace the flow state machine with agent teams

**What:** Migrate Canon's coordination layer off `drive_flow` + flow YAML + wave events + `post_message`/`get_messages` and onto Claude Code's native agent teams primitive. The orchestrator becomes the team lead: it reads a short declarative runbook, assembles per-teammate spawn prompts (the only context channel that works — proven experimentally), spawns teammates, and drives HITL breakpoints. Rolled out behind a `CANON_AGENT_TEAMS_MODE` feature flag with per-flow conversion. Principles, artifacts, drift, and review tooling are untouched — this is strictly a coordination-layer swap.

**Why:** The flow state machine, wave semantics, and the mailbox tools were built before Claude Code exposed multi-agent coordination. They exist to compensate for primitives that now ship natively. Deleting that layer is expected to remove 30–40% of `mcp-server/src/features/orchestration/` by line count while preserving every capability users actually care about. Canon's moat — principles + artifact-driven development + drift — becomes easier to see when the custom coordination scaffolding is gone.

### 0.2 Unify work tracking via the pinned task list

**What:** Pin `CLAUDE_CODE_TASK_LIST_ID` per workspace so single-session and team-based runs share one durable work-unit model. Tasks survive context compaction and cross-session resume, and `TaskCompleted` hooks enforce artifact production.

**Why:** Today Canon has two parallel notions of progress: the flow state machine on the coordination side and iteration rows on the execution side. A pinned task list gives one durable substrate that both humans and agents can see, and turns artifact enforcement into a hook concern instead of a state transition.

### 0.3 Runbooks replace flow YAML state machines

**What:** Short declarative YAML runbooks describing what agents to spawn, in what order, what artifact each produces, and where HITL gates sit. Read by the orchestrator (as team lead), not executed by a state machine. `fast-path.yaml` converts first; `feature`, `refactor`, `migrate`, `test-gap`, `review-only`, and `security-audit` follow. Epic (adaptive waves) is deferred until the runbook format is extended with branching.

**Why:** Once the state machine is gone, flows are just ordered spawn-and-artifact lists with a few HITL checkpoints. Runbooks make that explicit and drop the parser, validator, fragment inclusion system, and transition-target matcher that exist today.

### Items downstream of this migration

Several roadmap entries below are reshaped or absorbed by Tier 0:

- **Item 8 (Flow Extension and Typed Ports)** — scope shrinks. Runbooks don't need fragment composition or typed ports in the flow-YAML sense; extension and typing move into the spawn-prompt assembly library and the runbook schema itself.
- **Item 15 (Flows That Adapt Mid-Execution)** — becomes a team-lead concern. Mid-run adaptation is "the lead reads wave N's artifacts and decides which teammates to spawn for wave N+1," which is how agent teams natively work. No state machine extension needed.
- **Item 16 (Effort Budgets on Flows)** — re-homes onto `TeammateIdle` / `SubagentStop` hooks and task-list metadata instead of flow-runtime counters.
- **Item 21 (Compaction Nudge as a Flow Concern)** — becomes a task-list / session-level concern, not a flow-level one.
- **Item 23 (Fragment-Level Testing)** — likely obsolete. If fragments go away with the state machine, the thing being tested no longer exists. Revisit after Phase 2.

The items below are kept for now because they're scoped to principles, drift, documentation, or evaluation — independent of the coordination layer. Each will get a quick re-read after Phase 1 lands.

---

## Tier 1: Quick Wins

### 1. Preserve Agent Reasoning Across Context Compaction

**What:** When Claude Code compacts its context window during a long session, Canon will capture the compaction summary and append it to the active workspace's progress log. Contingent on Claude Code exposing a compaction hook event — if that hook isn't available, a fallback heuristic based on session length and tool-call volume gives an approximate signal.

**Why:** Long-running sessions accumulate goals, decisions, and blockers in the conversation. When compaction fires, that reasoning silently disappears. Capturing it means the scribe can still see what the agents were thinking when it syncs your documentation at the end of a flow.

### 2. Tool-Level Loop Detection

**What:** Canon already detects stuck states (an agent reporting the same status across iterations without progress). This adds a finer check at the tool-call level: when an agent repeats the same tool with the same inputs three times in a row within a single turn, Canon pauses the flow and surfaces the loop to you.

**Why:** The existing stuck detector catches loops that span iterations but misses tight within-agent loops — an agent retrying the same failing command dozens of times inside one turn. That's where most wasted effort actually happens. Catching identical-call loops earlier saves effort and gets you unstuck before the iteration-level detector fires.

### 3. In-Flight Spawn Watchdog

**What:** Canon will track a start timestamp for every agent spawn and check it on each orchestrator poll. When a single spawn exceeds a configurable wall-clock threshold (default: 20 minutes for implementors, shorter for other roles), Canon pauses the flow and surfaces the long-running agent to you with the option to wait, cancel, or intervene.

**Why:** Canon's stuck detection is iteration-based — it compares the last two `iteration_results` rows, which are only written after an agent reports back. While an agent is mid-spawn, nothing updates, so a single implementor can spin for an hour without any detector noticing. Tool-level loop detection catches tight inner loops but not slow-grind wheel-spinning, and flow-level effort budgets only fire at iteration boundaries. A per-spawn wall-clock heartbeat closes the gap between "agent started" and "agent reported" where Canon is currently blind.

### 4. Documentation Sync on Fast-Path

**What:** The scribe will run after fast-path builds (small bug fixes and simple changes), not just medium and large flows. It will skip quickly when there are no contract-level changes.

**Why:** Most bug fixes and small improvements go through the fast-path today, which skips the scribe entirely. Documentation drifts not because the scribe fails but because it never runs on small changes. Cheap skip logic means adding the step costs almost nothing when there's nothing to update.

### 5. Proactive Documentation Gap Detection

**What:** Before classifying a diff, the scribe will scan your project for directories that contain several source files but no `CLAUDE.md`. When it finds a gap, it creates a stub so the directory has baseline documentation going forward.

**Why:** The scribe currently only reacts to diffs. It can't answer "does this module deserve its own `CLAUDE.md`?" from a diff alone. Proactive discovery closes documentation gaps that passive diff-watching will never catch.

### 6. Explicit Code-to-Docs Mapping

**What:** A project-local configuration file where you declare which source directories are documented by which `CLAUDE.md` files. The scribe reads this mapping to know exactly which docs to update when a given area changes.

**Why:** Without an explicit mapping, the scribe has to guess which docs are affected by a change. Telling it directly — "changes under `src/orchestration/` affect these files" — eliminates the guesswork and makes sync behavior predictable.

### 7. Smarter Scribe Spawn Decisions

**What:** Before spawning the scribe, Canon will scan the diff for the signals that almost always warrant a doc update (exported signature changes, new routes, schema changes, new dependencies, new files). Obvious cases are pre-classified; the scribe only reasons about boundary cases.

**Why:** The scribe's hardest calls are "is this contract-level or internal?" Boundary cases tend to get classified as "internal, skip" — which is why documentation drift is almost always a sin of omission. Pre-classifying the obvious cases means the scribe runs when it should and focuses its judgment on the genuinely tricky ones.

---

## Tier 2: Infrastructure Refinements

### 8. Flow Extension and Typed Ports

**What:** Fragments (reusable state groups) already compose via includes. This adds two things on top: flows will be able to extend a parent flow to inherit its states, and fragment boundaries will become explicit typed contracts instead of string-matched transition targets.

**Why:** Adding a quality gate to every medium-or-larger flow today still means editing every flow file, because there's no inheritance — only inclusion. Flow extension gives a single point of change for pipeline patterns. Typed fragment boundaries catch composition bugs at load time instead of at runtime when a transition target silently fails to resolve.

### 9. Worktree Sandboxing and Audit Log

**What:** Canon already auto-approves a filtered allowlist of tools when an agent runs inside an isolated worktree, eliminating the 30-50 approval prompts that used to interrupt every build. Two gaps remain on top of that mechanism: hard path enforcement that denies writes outside the worktree, and an audit log recording every auto-approved action for after-the-fact review.

**Why:** The auto-approval allowlist constrains which tools agents can use, but it doesn't bound where those tools can write. An agent could still target an absolute path outside its worktree. Hard path enforcement turns the worktree into a real sandbox. The audit log makes "what did the agents actually do while I wasn't watching?" answerable instead of invisible.

### 10. Durable Agent Performance Metrics

**What:** Agents already record per-run metrics — tool call counts, orientation calls, turns — into their workspace. This adds two pieces: a rollup into a project-level store that survives workspace cleanup, and a query tool so you can see efficiency trends across flows.

**Why:** Today those metrics are trapped in per-workspace databases that get pruned. You can record them but you can't compare across runs or track whether agents are getting faster and more focused after you tune prompts or context injection. The rollup plus a query tool makes "did this change help?" an answerable question — even without token-level visibility, tool-call counts and orientation ratio are strong proxies for agent efficiency.

### 11. Finish Architectural Boundary Cleanup

**What:** Resolve the last known internal coupling violations between Canon's orchestration layer and its storage layers, and tighten the boundaries around the file-context query path.

**Why:** Canon enforces architectural boundaries in CI, and the two known exceptions are tracked as technical debt. Cleaning them up removes the exception list, simplifies the dependency graph, and makes future refactoring easier.

---

## Tier 3: Intelligence & Observability

### 12. Confidence Decay for Drift Reports

**What:** Drift reports will replace binary pass/fail with a confidence score between 0.0 and 1.0. The score decays as code changes accumulate without a re-review — more for bigger changes, less for smaller ones.

**Why:** Binary compliance is misleading. A file reviewed three months and 40 commits ago is technically "passing" but practically stale. Confidence decay prioritizes review attention toward the files that have drifted most since their last review, turning the drift report into an actionable triage list.

### 13. Hotspot and Co-Change-Aware Scribe

**What:** The scribe will receive signals from Canon's git intelligence layer about which files are hotspots (high churn and complexity) and which files frequently change together. Hotspots get extra documentation attention, and co-change partners that diverge trigger warnings.

**Why:** Canon already mines these signals from git history but nothing consumes them for documentation quality. High-churn files deserve thorough docs — they're where bugs cluster. Co-change partners that diverge from their usual pair are a reliable "someone forgot to update the sibling" signal.

### 14. Documentation Staleness in Drift Reports

**What:** Drift reports will include a documentation freshness dimension alongside principle compliance. Each `CLAUDE.md` gets a "commits since last sync" count and a confidence score that decays over time.

**Why:** Drift reports currently only cover principle compliance. Documentation freshness is an equally important quality signal — a `CLAUDE.md` that hasn't been touched through 20 commits of changes to its directory is likely misleading every agent that reads it.

### 15. Flows That Adapt Mid-Execution

**What:** Flows already support simple pre-check skip conditions. This extends them in two ways: skip conditions will accept rich expressions over project state (files changed, layers touched, gates passed, artifacts present, custom metadata), and agents will be able to request flow changes mid-run — "I found three unknown subsystems, insert a research step" — through a controlled mechanism you approve in advance.

**Why:** Today's skip conditions are evaluated once at load time against a narrow set of signals, so flows are effectively static once they start. If a fast-fix discovers mid-execution that it needs a design phase, the only escape is to interrupt you. Richer expressions and bounded mid-run requests let Canon handle more cases mechanically without requiring you to be present, while keeping the set of allowed modifications explicit and bounded.

### 16. Effort Budgets on Flows

**What:** Looping states already declare a maximum iteration count. This extends that into a full effort budget expressed in terms Canon can observe — maximum tool calls per state, maximum wall-clock duration, and maximum agent spawns per flow — plus a "focus and wrap up" note injected when an agent is approaching the limit and a pause for your approval when it hits.

**Why:** Max iterations catches flows that loop structurally, but a single fixer agent in a retry loop can burn significant effort inside one iteration before Canon notices. Claude Code doesn't expose token counts to plugins, so token-based budgets aren't possible — but tool-call and duration limits are strong proxies that catch spiraling agents faster than iteration limits alone. Flow-level limits give you a single "approve more effort?" decision instead of watching an unproductive loop grind on.

---

## Tier 4: Cross-Session Learning & History

### 17. Background Janitor Agent

**What:** A single background agent that owns all housekeeping: pruning stale worktrees and merged-branch workspaces, checkpointing databases, extracting decision records from completed flows, trimming old transcripts, refreshing the knowledge graph, and running the learner when its gate opens. Triggered automatically after flows and on session start.

**Why:** Half of Canon's housekeeping runs inline at flow completion (making each flow slower as features accumulate) and the other half depends on manual action or optional git hooks. Stale worktrees pile up, transcripts grow unbounded, and the "nobody's job" gaps compound over time. A single idempotent janitor fixes all of it without blocking any flow.

### 18. Short-Term Memory for Recently-Touched Areas

**What:** When agents touch a subsystem, Canon captures compact factual observations — patterns observed, recent changes, known gotchas — and attaches them to that area of the codebase with a short expiry (default seven days). The next agent that works in the same area gets those observations pre-injected into its context.

**Why:** When you run three feature flows touching the same subsystem in a week, each researcher re-discovers the same architecture, each implementor re-learns the same patterns. There's no short-term memory between permanent static context and slow-cycle learning. Auto-expiring observations fill that gap without the staleness risks of permanent storage.

### 19. Cross-Session Error and Fix Memory

**What:** When an implementor summary records a fix for a specific kind of build or test failure, Canon remembers the association. The next time a fixer agent encounters a similar failure, the known fix is injected into its context as a starting hypothesis.

**Why:** Canon's fixer agents diagnose failures from scratch every time. There's no persistent memory across sessions, so the same error gets re-reasoned from first principles on every occurrence. Remembering past fixes means familiar errors get resolved immediately instead of re-investigated.

### 20. Workflow Pattern Mining

**What:** The learner will analyze execution history across many builds to find repeated agent sequences — for example, "implement → fail → fix → re-test appears in 70% of feature builds." High-frequency patterns surface as candidates for new flow variants or principle suggestions.

**Why:** Patterns that repeat across many builds are invisible to the current pipeline. If Canon keeps landing in the same fix loop for a certain class of task, that's a signal the flow should include a pre-implementation verification step by default. Mining history surfaces those signals instead of leaving them buried.

### 21. Compaction Nudge as a Flow Concern

**What:** When a flow has run for many iterations without a context sync, Canon surfaces a soft "you may want to compact" suggestion. Implemented as a declarative condition on the sync state, not a runtime heuristic in the dispatcher.

**Why:** Sessions can drift into degraded context quality without any visible signal. The nudge gives you one. Declaring it at the flow level keeps the behavior explicit, testable, and easy to tune per flow type — epic flows can reasonably have a different threshold than single-task flows.

---

## Tier 5: Evaluation & Testing

### 22. Deterministic Agent Evaluation

**What:** A framework for capturing "golden" input/output pairs from successful flows as evaluation fixtures, checked into git. A new command replays those fixtures through current agent definitions and diffs the structured outputs against the golden baseline.

**Why:** When you change an agent's instructions or tune the prompt pipeline, there's no baseline to compare against today. Improvements are vibes-driven. Fixtures turn "did this change help?" from guesswork into an actual diff, and they become a regression suite for agent behavior.

### 23. Fragment-Level Testing

**What:** Fragments will be able to declare minimal test scenarios in their frontmatter — sequences of state-and-status pairs and an expected terminal state. Canon's flow simulator runs them in isolation without spawning any agents.

**Why:** Fragments power almost all multi-step flows, and a bug in one fragment propagates to every flow that uses it. Today the only way to test a fragment is to run a full flow through it. Isolation tests catch composition bugs in milliseconds instead of waiting for the next real build to surface them.

### 24. Eval Scenario Library

**What:** A library of small purpose-built seed repositories paired with task scenarios and ground-truth test suites. Canon runs each scenario end-to-end and scores the results with a three-tier grader stack (structural, behavioral, and semantic). An A/B protocol lets you compare configurations head-to-head.

**Why:** Golden fixtures are reactive — you can only build them from flows that already succeeded. Eval scenarios are proactive: reproducible benchmarks with known-correct outcomes that let you measure whether a configuration change actually improves real results on realistic codebases, not just matches a past snapshot.

---

## Tier 6: Future Consideration

### 25. Session-Start Documentation Health Check

**What:** On session start, Canon surfaces a brief advisory when any `CLAUDE.md` in your project has a low freshness confidence score. The same system gives each `CLAUDE.md` a quality score across completeness, freshness, specificity, and coverage.

**Why:** Documentation quality is currently invisible until someone reads a stale file and gets misled. A lightweight session-start signal turns that into a gentle nudge — "three docs may be stale" — without blocking anything. Quality scores make "good documentation" measurable.

### 26. Test Coverage Mapping

**What:** Canon's knowledge graph already infers which tests cover which files from static imports. This would augment that with actual runtime coverage data from your test runner.

**Why:** When an agent modifies `foo.ts`, knowing that `bar.test.ts` covers it means the agent can run exactly the relevant tests instead of the full suite. Runtime coverage is more accurate than import analysis and catches transitive dependencies the static view misses.

### 27. Hot-File Caution for Implementors

**What:** When an implementor is about to edit a file that has been modified across many recent builds, Canon would inject a caution note naming the build history.

**Why:** Likely redundant — Canon's file-context tool already surfaces more structurally meaningful information (blast radius, import/export analysis, graph metrics). Worth evaluating whether a frequency signal adds anything actionable before building it.

### 28. Idea-to-Spec Flow

**What:** A new flow that takes a vague idea — "I want to rebuild notifications" or "something is off with the checkout funnel" — and drives it through structured clarification into a concrete spec you can feed back into a build flow. It runs conversational research, surfaces assumptions, asks clarifying questions, and produces a written spec as its output.

**Why:** Canon's existing flows all assume you already know what you want. There's no flow designed to help you figure out what you want. Today you either talk it through yourself or use the explore flow for research, but neither produces a concrete spec at the end. An idea-to-spec flow closes that gap so the handoff from "I have a rough idea" to "I'm ready to build" is a Canon workflow instead of a manual conversation.
