# Canon agent-teams migration — comprehensive plan v2 kickoff

## Context you need

You are picking up a planning task. A previous session executed Phase 1 and Phase 2 of a Canon → Claude Code agent-teams migration against an existing plan at `docs/agent-teams-migration-plan.md` (committed to main as `9b3480c docs: add agent-teams migration plan and Tier 0 roadmap entry`). After Phase 2 was substantively complete — code reviewed clean, tests passing, PR #112 open — an audit revealed that the v1 plan had a **fundamentally flawed mental model**: it scoped the migration as "replace the drive_flow state machine with runbooks" but failed to enumerate the ~20+ supporting services that `drive_flow` composes at spawn time. The Phase 1 and Phase 2 code is architecturally sound against the v1 plan but collectively provides roughly 10–15% of what `drive_flow` actually does at spawn time.

The user has decided to **abandon Phase 1 and Phase 2 entirely** and commission a comprehensive replacement plan. None of the Phase 1 or Phase 2 code is on main — it lives only on feature branches (`canon/agent-teams-phase-2`, `claude/canon-agent-teams-migration-gICh6`, `claude/phase-2-runbook-conversion-jo2qH`). **The only migration artifact on main is `docs/agent-teams-migration-plan.md` (v1).**

Your task is to draft the comprehensive v2 plan.

---

## What v1 got wrong

The v1 plan is at `docs/agent-teams-migration-plan.md` on main. Read it first. Its core hypothesis, §2:

> The coordination layer is overbuilt. Most of `drive_flow`, the flow YAML runtime, wave semantics, wave events, and `post_message` / `get_messages` exists to compensate for coordination primitives Claude Code did not previously expose. Now that it does, we can delete a meaningful chunk of the MCP server.

This is true about *scheduling* but wrong about *composition*. Over the last two weeks the `drive_flow` pipeline accreted many cross-cutting integrations that are not state-machine mechanics — they are services that compose at spawn time and flow time to produce Canon's actual value. The v1 plan's §6 Phase 3 is a single sentence ("Convert epic / adaptive waves") and Phase 4 is pure deletion. Neither phase enumerates the integrations the legacy runtime provides; both assume the supporting services will "fall out" when `drive_flow` is deleted. **They will not.** If Phase 4 ran as written, Canon would silently lose every integration listed below.

The plan was last updated 2026-04-10, but several user-visible features landed 2026-04-08 and 2026-04-09 (auto-approve worktree settings injection, agent provenance trailers, file claims lifecycle) and were never reflected in the plan.

---

## The 27 integration gaps (audit output)

An integration audit compared `drive_flow`'s spawn path to `lead-mode.ts`'s runbook path (the Phase 1/2 replacement). It found 27 real gaps plus one already-known auto-approve gap. Severity: 11 HIGH, 11 MEDIUM, 5 LOW. Your v2 plan must address every one of these by explicitly committing to either (a) wire it onto the new path, (b) deprecate it intentionally with rationale, or (c) declare it out of scope with rationale.

### HIGH severity

1. **Auto-approve settings injection** — `injectSettingsIntoRequests` writes `.claude/settings.local.json` into each agent's worktree to pre-approve its tool list; depends on `req.permission_mode === "auto"` + `worktree_path` + `tools`. Lead-mode's `SpawnDescriptor` carries none of these fields.
2. **Tool profile resolution** — `resolveToolProfile(agent)` maps each Canon role to an allowed/disallowed tool list plus permission_mode and write_scope. Without it, teammates get Claude Code's default tool set, violating `agent-tool-scope-minimization` and breaking scoped-write guarantees.
3. **Workspace worktree creation** — `createWaveWorktrees` creates `.canon/worktrees/<task_id>` with per-task branches (`canon-wave/{task_id}`). Wave isolation contract (file-claims non-overlap, per-task branches, rebase-merge) depends on this. Runbook path does no git ops.
4. **Context enrichment** — `assembleEnrichment` produces a four-section block (Recent Changes, Drift Signals, Prior Work, Tensions) from git log, DriftStore, sibling artifacts, and cross-references. KG degree/hotspot/co-change data also injected via `inject-context.ts`. Runbook path emits a bare "Target files" bullet list with no enrichment.
5. **Principle loading** — Legacy pipeline injects matched principles (full bodies) filtered by files/layers/tags/severity via `shared/matcher.ts`. Runbook path emits a static "Consult the principles layer" sentence with no actual principles. Canon's core value proposition: principle-grounded agents.
6. **Commit provenance trailers** — `formatCommitTrailers({ agent, state, taskId, workflow })` adds Canon-Workflow / Canon-Agent / Canon-State / Canon-Task trailers to every spawn prompt's `## Commit Provenance` section. Runbook path has no such section — commits lose Canon attribution.
7. **File claims** — `registerClaims` / `releaseClaims` / `checkClaimOverlaps` persist to `.canon/claims.json` to prevent concurrent workflows from stomping the same files. Runbook workflows are invisible to the claims system.
8. **Post-state effects** — `executeEffects` runs `persist_review` (writes reviewer artifact to DriftStore) and `check_postconditions` (runs contract-checker assertions). Runbook path drops both silently.
9. **Wave policy** — `WavePolicy { isolation, merge_strategy, on_conflict, gate, coordination }`. Canon flows like `epic.md` and `migrate.md` rely on `merge_strategy: rebase` and `on_conflict: hitl`. Runbook path has only `wave?: boolean` — no policy.
10. **HITL breakpoint presentation** — `drive_flow` returns five distinct breakpoint shapes with context/reason/options for post-report HITL, approval gate, convergence exhausted, gate failure, pause wave event. Runbook has a single string `hitl: false | "after" | "after_if_verdict_not_clean"` — approximately one-tenth the HITL vocabulary.
11. **Workspace bootstrap** — `init_workspace` creates the directory, seeds progress.md, builds cache prefix, runs preflight checks, creates worktrees. Runbook path assumes the workspace already exists. Phase 4 cannot delete `init_workspace` without a replacement.

### MEDIUM severity

12. **Session continuation (ADR-009a)** — `applySessionContinuation` adds `continue_from: { agent_id, context_summary }` to spawn requests when an agent session exists and is <10 min old. Improves context continuity on resume.
13. **Inter-wave gates** — `WavePolicy.gate?` runs a shell gate between waves (e.g., `gate: test-suite`). Not representable in runbook format.
14. **Wave briefing assembly** — `wave-briefing.ts` injects a "Prior wave summary" block into wave-2+ teammates. Runbook path has only upstream artifact refs (partial coverage).
15. **Consultation prompts** — `consultations: { before, after }` on state defs drive pre/post-wave advisory consultations. Not representable in runbook format.
16. **Discovered gates / postconditions recording** — Agents report `discovered_gates` / `discovered_postconditions` via `report_result`; accumulate on `BoardStateEntry` and feed forward. Runbook path has no channel for this.
17. **Agent metrics recording** — `record_agent_metrics` tool stores `tool_calls`, `orientation_calls`, `turns` on state metrics. Flows into `FlowRunEntry` analytics. Runbook path has no board to write to.
18. **Agent activity logging** — `post_event` tool writes `agent_activity` events to the execution store's event log. Hooks fire `SubagentStart/Stop/TaskCompleted` into the same channel. Runbook path has no event emitter.
19. **Drift tracking / review persistence** — `persist_review` effect reads `REVIEW.meta.json` or parses `REVIEW.md` and calls `DriftStore.appendReview`. Subset of gap #8. DriftStore blind to every runbook-path review.
20. **Learn gate evaluation (ADR-016)** — `evaluateLearnGate(projectDir)` decides whether `canon-learner` auto-triggers at flow completion. Runbook path has no completion phase.
21. **Flow run analytics** — `update_board complete_flow` aggregates gate/postcondition/violation/test metrics across board states into a `FlowRunEntry` via `DriftStore.appendFlowRun`. Runbook path has no board.
22. **Flow event channel drain** — `drainFlowEvents` reads events posted by agents mid-flow (e.g., "insert a research state", "skip this", "escalate") and returns an override action. Runbook path is strictly linear — no insertion/escalation vocabulary.

### LOW severity

23. **Variable interpolation** — `${WORKSPACE}`, `${slug}`, `${base_commit}`, `${task}`, `${task_id}` in legacy spawn instructions. Runbook format uses structured fields instead; this is a design improvement, not a gap. **Do not wire this.**
24. **Template loading** — Already wired. `ROLE_ARTIFACT_CONTRACTS.template` is referenced in the completion contract.
25. **Competitive / debate protocols** — `compete.count: 2`, `synthesis` strategies, debate protocol. Used by `migrate`. Niche.
26. **Parallel roles** — `type: parallel` with `roles: [migration-scope, rollback-plan]`. Used by `migrate.research`. Niche — arguably covered by multiple sibling runbook steps.
27. **Skip conditions** — `skip_when: no_contract_changes | auto_approved | learn_gate_not_passed`. Runbook authors can just omit steps, but dynamic skip has no equivalent.
28. **Stuck detection / iteration caps / convergence / approval gate** — `max_iterations`, `stuck_when`, `max_revisions`, legacy `approval_gate: true`. Runbook `hitl: after` covers the approval-gate case only. Runbook model is one-shot per step by design.

---

## Existing code to reference but not keep

The Phase 1 + Phase 2 code lives on these branches as read-only reference. You can cite specific files/lines when explaining why a v2 architecture decision differs. You MUST NOT merge or amend these branches:

- **`canon/agent-teams-phase-2`** — Phase 2 tip, includes post-review Canon fixes and the Boy Scout pr-review test refactor. Treat as frozen history.
- **`claude/canon-agent-teams-migration-gICh6`** — Phase 1 baseline (also the base of PR #112).

Key files the fresh session may want to inspect for architectural precedent:

- `mcp-server/src/domains/spawn/index.ts` — the pure `assembleSpawnPrompt` + `WAVE_ARTIFACT_SUFFIXES` + `resolveWaveArtifactPath`. The data shape is reusable; the "caller is responsible for principles/enrichment" comment on line 11 is where the v1 design went wrong.
- `mcp-server/src/features/orchestration/lead-mode.ts` — `parseRunbook`, `planRun`, `buildStepDescriptor`, `buildWaveStepDescriptors`, `writeTaskArtifactState`. The wave-expansion *logic* is correct; the *composition surface* (what a descriptor carries) is insufficient.
- `skills/canon/runbooks/*.yaml` — seven existing runbooks (fast-path + six Phase 2 conversions). The wave/flat distinction and the HITL field are reusable; the single `hitl` string is insufficient vocabulary.
- `hooks/canon-agent-teams/*.sh` — three hook scripts (artifact-enforce, idle-backstop, observability). Reusable as-is.
- `docs/phase-2-conversion-notes.md` — documents Phase 2's per-flow divergences from legacy behavior and includes a drift report comparing simulated legacy flows to runbook plans. Useful input for v2's phase-by-phase acceptance criteria.

The Canon-style review that blessed Phase 2's internal quality (CLEAN verdict, no violations) is on PR #112. It is not a substitute for the integration audit above — it evaluated what the Phase 2 code did, not what it failed to do.

---

## What the v1 plan got right

Do not discard these ideas in v2:

1. **The runbook format as data-over-code.** Linear YAML for straight pipelines, escalation to branching only when needed.
2. **Hook-based artifact enforcement.** `TaskCompleted` + `TeammateIdle` hooks with workspace-local state files is a clean enforcement channel.
3. **The pinned task list for cross-session resume.** `CLAUDE_CODE_TASK_LIST_ID` + `~/.claude/tasks/<id>/` as the durable work-unit substrate.
4. **Feature flag gating.** `CANON_AGENT_TEAMS_MODE=off` must remain byte-identical to the legacy `drive_flow` path throughout the migration. No user surprises.
5. **Phased rollout with scoped boundaries.** One migration step at a time, each independently verifiable.
6. **Principles and artifact layers as the engine's product.** Canon's differentiation lives in those two layers; the coordination layer is commodity.

What v1 missed is that "the coordination layer" is not just `drive_flow` the state machine — it is `drive_flow` plus `features/prompt-pipeline/` plus `services/context-enrichment.ts` plus `services/wave-briefing.ts` plus `engine/effects.ts` plus `shared/lib/commit-trailers.ts` plus `shared/lib/file-claims.ts` plus the entire `tools/*.ts` MCP surface. **All of that accretes at spawn time and flow-completion time.** The v1 plan's mental model treats these as internal plumbing; in reality they *are* Canon's user-visible behavior.

---

## What the v2 plan must contain

Draft `docs/agent-teams-migration-plan-v2.md` with at minimum these sections. Treat this as a requirements document — every bullet is a section you must write, not a suggestion.

1. **Frontmatter**: status, owner, last updated, pointer to v1 as superseded.
2. **Context** — explain what v1 got right and what it missed. Do not soft-pedal. The audit's 27 gaps are the primary evidence. Cite specific legacy-path services by file path.
3. **Target architecture overview** — a diagram or numbered list describing the replacement shape. The v2 architecture is NOT "lead-mode.ts as a pure planner." It is more like:
   - A runbook loader (data)
   - A plan-time pipeline that takes a runbook + workspace state and produces fully-hydrated spawn descriptors
   - The pipeline has explicit stages: tool profile resolution, worktree creation, principle resolution, context enrichment, commit provenance, consultation pre-briefing, wave briefing, HITL classification
   - A run-time coordinator that watches the task list, receives hook events, drives HITL breakpoints, and invokes post-state effects
   - A completion phase: learn gate, flow analytics, claims release, drift persistence
4. **Target `SpawnDescriptor` shape** — enumerate every field the new descriptor must carry. At minimum from the audit: `role`, `task_type`, `task_id`, `spawn_prompt`, `artifact`, `artifact_path`, `tools`, `disallowed_tools`, `permission_mode`, `worktree_path`, `continue_from?`, `wave_context?`, `required_artifacts`, `hitl` (as a structured breakpoint config, not a string), plus any wave-policy fields for wave-expanded descriptors. Explain each field's source and consumer.
5. **Target `lead-mode.ts` pipeline stages** — what does the orchestrator do from "runbook loaded" to "descriptors ready to spawn"? Name each stage, its inputs, outputs, and whether it is currently in legacy (cite the legacy implementation) or needs a new implementation.
6. **Workspace lifecycle** — how does a runbook run start and end? Cover: workspace directory creation, cache prefix, progress.md seeding, preflight checks, worktree lifecycle (create, merge, cleanup), claims register/release, completion event, analytics write. Match the legacy lifecycle feature-for-feature or justify the divergence.
7. **HITL breakpoint model** — design the v2 replacement for legacy's five breakpoint shapes. It must cover: post-artifact verdict inspection, architect approval gate, convergence exhausted, gate failure, paused wave events. Specify the data shape, the presentation contract, and the re-entry protocol.
8. **Wave policy schema** — extend the runbook step to carry `wave_policy`. Match the legacy `WavePolicy` schema or justify the divergence. Specify how the merge driver, conflict handler, and inter-wave gate are invoked.
9. **Integration disposition table** — one row per audit gap (all 28). Columns: gap number, name, severity, disposition (`wire` / `deprecate` / `out of scope`), rationale, which phase owns it, legacy reference path.
10. **Phase boundaries** — replace v1's Phase 1..4 with explicit phases that each have:
    - Goal (one sentence)
    - Deliverables (file paths, types, functions)
    - Exit criteria (testable — "all 11 HIGH-severity gaps wired", not "feature complete")
    - Explicit "MUST NOT touch" list
    - Explicit preconditions (what must be true before this phase starts)
    The phases MUST include a Phase that explicitly wires every HIGH-severity gap before any deletion phase. Phase 4 (deletion) MUST NOT run until every wired gap has a verified replacement.
11. **Validation strategy** — how does each phase prove it is complete? Specify the test-suite shape, the smoke-test harness shape, the regression-check requirements (feature-flag-off byte-compat), and the rollback path.
12. **Deletion pre-conditions for Phase N (final)** — an explicit checklist that must hold before `drive_flow.ts`, `features/prompt-pipeline/`, `services/*.ts`, etc. can be deleted. Every legacy integration path must have a confirmed replacement with test coverage.
13. **Risks** — carry forward v1's risks and add: "the plan may have missed integrations" risk, with a mitigation (a re-audit checkpoint between Phase 2 and Phase 3).
14. **Out of scope** — what v2 explicitly does NOT attempt, with rationale.

**Length target**: 3,000–6,000 words. Prose for rationale, tables for integration disposition and phase deliverables, code samples only where a type shape is not obvious from prose.

---

## Working constraints for the v2 drafting session

- **No code changes in this session.** You are writing a plan document, not executing it. Do not edit any `.ts`/`.yaml`/`.md` file under `mcp-server/src/` or `skills/canon/runbooks/` or `hooks/canon-agent-teams/`.
- **New branch off main.** Create `canon/agent-teams-migration-plan-v2` off `origin/main`. Do not base off `canon/agent-teams-phase-2`.
- **Do not touch the v1 plan file on main** in this draft. v2 lives at `docs/agent-teams-migration-plan-v2.md` as a new file. The PR that merges v2 can optionally add a superseded banner to v1 in a follow-up commit.
- **Do not close or amend PR #112.** The user will handle that separately.
- **Do not delete or mutate `canon/agent-teams-phase-2` or `claude/canon-agent-teams-migration-gICh6`.** These are read-only reference.
- **Feature-flag invariant stays.** Whatever the new plan specifies, `CANON_AGENT_TEAMS_MODE=off` must remain byte-identical to today's legacy path throughout the migration.
- **Banned from Phase scope: rewriting anything on main.** Phase 1 in v2 will add new files; it will not rewrite `mcp-server/src/features/orchestration/tools/drive-flow.ts` or any legacy file.

---

## First actions for the fresh session

1. Read `docs/agent-teams-migration-plan.md` (v1) from main end-to-end. Note the mental-model flaw in section 2 and the narrow Phase 3 / Phase 4 scope in section 6.
2. Read `mcp-server/src/features/orchestration/tools/drive-flow.ts` on main — this is the legacy entry point and the v2 plan's primary comparison target. Pay attention to `tryEnterSingleState`, `enterWaveState`, `startNextWave`, and the spawn-request pipeline (`buildSpawnRequests`, `applySessionContinuation`, `injectSettingsIntoRequests`).
3. Read `mcp-server/src/features/prompt-pipeline/` on main to inventory the prompt-assembly stages (`inject-coordination.ts`, worktree settings injection, commit trailers, file claims) that v1 missed.
4. Spot-check the existing Phase 2 code on `canon/agent-teams-phase-2` branch (`git show canon/agent-teams-phase-2:mcp-server/src/features/orchestration/lead-mode.ts | head -200`) for architectural precedent only.
5. Create branch `canon/agent-teams-migration-plan-v2` off `origin/main` and start drafting `docs/agent-teams-migration-plan-v2.md`. Commit iteratively — one commit per major section so review can be incremental.
6. When the draft is complete, push the branch and open a PR against main for human review. Do NOT merge.

---

## Deliverable

- `docs/agent-teams-migration-plan-v2.md` on branch `canon/agent-teams-migration-plan-v2` pushed to origin
- PR against main, draft-quality, for human review
- No code changes anywhere in the repo
- Frontmatter must cite this kickoff prompt and the 28-gap audit as its source material

## Out of scope for this session

- Executing any phase of v2 (that's a separate session after v2 is approved)
- Closing or modifying PR #112
- Modifying or deleting any existing branch
- Rewriting the v1 plan on main
- Writing any new source code

---

**This prompt is self-contained. Start by reading v1, then drafting.**
