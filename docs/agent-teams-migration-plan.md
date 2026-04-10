# Canon → Agent Teams Migration Plan

Status: proposed, Phase 1 ready to execute.
Owner: Canon maintainers.
Last updated: 2026-04-10.

This document is the authoritative plan for migrating Canon's coordination layer from a custom MCP-driven state machine to Claude Code's native agent teams primitive. It is scoped to be readable cold by a remote session.

---

## 1. Context

Canon today consists of three logical layers:

1. **Principles layer** — MCP tools for principle definitions, drift tracking, compliance checks, graph queries, reviewer scoring. This is Canon's actual moat and stays.
2. **Artifact layer** — typed MCP writers for research syntheses, design briefs, plan indexes, implementation summaries, test reports, reviews. Files land under `.canon/workspaces/<id>/`. Stays.
3. **Coordination layer** — flow YAML runtime, `drive_flow` state machine, waves, wave events, `post_message` / `get_messages`, orchestrator-as-pure-dispatcher discipline. This was built before Claude Code exposed native multi-agent coordination. **This is what the migration replaces.**

Claude Code shipped experimental **agent teams** (v2.1.32+). A lead session spawns teammates with arbitrary per-teammate spawn prompts, teammates run in independent contexts, the lead can add or remove teammates dynamically over the team's lifetime, and hook events fire on a well-defined lifecycle.

### What we verified experimentally on 2026-04-10

Three runs against Claude Code v2.1.98 with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, captured in `/tmp/canon-teams-experiment/`:

- **Dynamic team composition works.** The lead can spawn teammates throughout a team's lifetime. Two sequential teams in one session with clean teardown between them. `~/.claude/teams/` was empty before and after the run.
- **Agent definition compatibility.** None of Canon's 13 agent defs (`agents/*.md`) use `skills:` or `mcpServers:` frontmatter. All are reusable as teammate types verbatim. `tools`, `model`, and the prompt body all carry through to the teammate path per docs.
- **Hook lifecycle confirmed.** `SubagentStart`, `SubagentStop`, `TeammateIdle`, `SessionStart`, `SessionEnd`, and `UserPromptSubmit` all fire reliably. `SubagentStart` payload carries `agent_id` and `agent_type` (the teammate name). `SubagentStop` carries `agent_transcript_path` and `last_assistant_message`. `TeammateIdle` is the only event carrying both `teammate_name` and `team_name`.
- **Per-turn hook semantics.** Each teammate turn fires its own SubagentStart/Stop cycle. Hooks observe turns, not lifetimes.
- **Teammate context injection is spawn-prompt-only.** UserPromptSubmit hook injection was tested with a unique timestamped marker. The marker appears only in the lead's transcript (6 occurrences) and never in any teammate transcript. A probe teammate asked whether it could see the marker replied `no markers`. SessionStart does not fire for teammates. SubagentStart stdout is not in the context-injection allowlist. **There is no hook-based channel to inject text into a teammate session. Period.**
- **Tasks are optional.** Two teams ran entirely without creating any tasks; `TaskCreated` / `TaskCompleted` never fired. Tasks are opt-in ceremony, not required.
- **Tasks, when used, give durable state and hook anchors.** Per docs, `CLAUDE_CODE_TASK_LIST_ID` pins a task list to a named directory under `~/.claude/tasks/` that persists across sessions and across context compactions. `TaskCreated` and `TaskCompleted` fire reliably when tasks are used. This is the unifying substrate for work tracking.
- **Teammate→lead messages are delivered as UserPromptSubmit events in the lead's session**, wrapped in `<teammate-message teammate_id="…">…</teammate-message>` envelopes. Observed during experiment 2.
- **Cross-session resume is broken for in-process teammates**, per docs. We treat on-disk artifacts and the task list (when pinned via `CLAUDE_CODE_TASK_LIST_ID`) as the durable substrate; teammates are ephemeral.

### What is invalidated

- The "install a SessionStart hook that injects Canon context into every teammate" idea is dead. SessionStart does not fire for teammates.
- The "install a TaskCreated hook that enriches task descriptions" idea is dead. TaskCreated can only block with exit 2, not rewrite the payload.
- The "orchestrator is a pure dispatcher" discipline becomes unnecessary. The orchestrator is the team lead, and a team lead legitimately assembles context and makes spawn decisions.

---

## 2. Hypothesis

The coordination layer is overbuilt. Most of `drive_flow`, the flow YAML runtime, wave semantics, wave events, and `post_message` / `get_messages` exists to compensate for coordination primitives Claude Code did not previously expose. Now that it does, we can delete a meaningful chunk of the MCP server and replace it with:

- The Claude Code task list (pinned per workspace via `CLAUDE_CODE_TASK_LIST_ID`) as the durable work unit.
- Spawn prompts assembled by the orchestrator at teammate-spawn time as the sole context channel.
- `TaskCompleted` hooks for artifact enforcement.
- `TeammateIdle` hooks as a backstop.
- Flow runbooks (short declarative YAML) describing what agents to spawn, in what order, what artifacts each produces, and what HITL gates exist — read by the orchestrator, not executed by a state machine.

Canon's principles and artifact layers remain untouched and become the engine's actual product.

---

## 3. Goals

- Delete the flow state machine runtime without losing any of Canon's principle, artifact, or drift capabilities.
- Unify single-session and team-based execution under one work-unit model (tasks pinned via `CLAUDE_CODE_TASK_LIST_ID`).
- Move context injection fully into the orchestrator at spawn time.
- Enforce artifact production via hooks rather than state transitions.
- Reduce the orchestrator's responsibilities to: spawn decisions, context assembly, HITL breakpoint presentation.
- Preserve cross-session resume via on-disk artifacts and the pinned task list.
- Retain all 13 Canon agent defs without modification.

## 4. Non-goals

- No changes to principles, rules, conventions, drift tracking, compliance, graph, or review tooling.
- No changes to artifact schemas or storage layout (`.canon/workspaces/<id>/`).
- No commitment to agent teams outside the wave-execution context. Single-agent flows (e.g., canon-guide, canon-chat, canon-writer) remain unchanged.
- No nested teams (unsupported by Claude Code).
- No removal of the MCP server. It gets leaner, not deleted.

---

## 5. Architecture change summary

**Today:**
```
orchestrator → load_flow → drive_flow loop → SpawnRequest → Agent() calls
              ↳ wave events, HITL, post_message/get_messages plumbing
              ↳ state machine enforces artifact existence and transitions
```

**After migration:**
```
orchestrator → read runbook → assemble spawn prompts → spawn teammates
              ↳ task list is durable via CLAUDE_CODE_TASK_LIST_ID
              ↳ TaskCompleted hook enforces artifacts
              ↳ TeammateIdle hook prevents premature stop
              ↳ cross-session resume reads artifacts + task list
```

---

## 6. Phased rollout

### Phase 0 — Preparation (no behavior change)

- Land this plan document on main.
- Add a feature flag `CANON_AGENT_TEAMS_MODE` (env var) defaulting to `off`. Nothing reads it yet.
- Audit and document every call site of `drive_flow`, `load_flow`, `init_workspace`, `post_message`, `get_messages`, `report_result`. Produces `docs/coordination-layer-audit.md`.

### Phase 1 — Foundation (feature-flagged, parallel to existing code)

This is the scope handed off to the remote session.

1. Add `mcp-server/src/features/spawn/` module: pure library for assembling spawn prompts from a task descriptor + workspace state. Takes `{task_type, target_files, upstream_artifact_refs, role}` and returns a fully-formed prompt string containing principles, file context, relevant conventions, upstream artifacts, and a standardized task-completion contract. No MCP tool surface. Exported for use by the orchestrator.
2. Add `skills/canon/runbooks/` directory with one runbook file: `fast-path.yaml`. Runbook schema:
   ```yaml
   name: fast-path
   description: Bug fix or small change, 1–3 files
   steps:
     - role: canon-researcher
       artifact: research_synthesis
       hitl: false
     - role: canon-architect
       artifact: plan_index
       hitl: after
     - role: canon-implementor
       artifact: implementation_summary
       hitl: false
     - role: canon-reviewer
       artifact: review
       hitl: after_if_verdict_not_clean
   ```
3. Add `hooks/canon-agent-teams/` directory with three hook scripts:
   - `artifact-enforce.sh` — `TaskCompleted` hook. Reads the task payload, looks up the expected artifact path from a workspace-local config, exit 2 with feedback if the file doesn't exist.
   - `idle-backstop.sh` — `TeammateIdle` hook. Reads the workspace state, checks whether the teammate's expected artifact exists, exit 2 with feedback if not.
   - `observability.sh` — logs SubagentStart, SubagentStop, TeammateIdle events to `.canon/workspaces/<id>/events.jsonl` for post-hoc analysis and drift.
4. Add a `hooks/canon-agent-teams/hooks.json` that wires the three scripts into the appropriate events.
5. Add `mcp-server/src/features/task-list/` module: thin wrapper over `~/.claude/tasks/<CLAUDE_CODE_TASK_LIST_ID>/` for reading/writing task state from the MCP server side. Needed so the orchestrator can enumerate tasks without going through Claude Code. Read-only at first.
6. Add orchestrator entry point gated on `CANON_AGENT_TEAMS_MODE=on`: `mcp-server/src/features/orchestration/lead-mode.ts`. When enabled, on a build request it reads the runbook, assembles spawn prompts via the spawn module, creates tasks in the pinned task list, and drives the team lead loop. When disabled, existing `drive_flow` path runs as today.
7. Wire `CLAUDE_CODE_TASK_LIST_ID` into the Canon workspace bootstrap: when a workspace is created, derive a stable ID from the workspace slug and export it into the environment for the current session. Document that users must launch Claude Code with this env var pinned for cross-session resume to work.
8. End-to-end smoke test: with the flag on, run `fast-path` against a tiny fixture project. Verify: team spawns, researcher produces synthesis, architect produces plan, HITL gate presents, implementor produces summary, reviewer produces review verdict, team tears down, artifacts exist under `.canon/workspaces/<id>/`. Capture the run in `docs/phase-1-smoke-test.md`.
9. Document the new mode in `docs/agent-teams-mode.md`: how to enable, what runbooks exist, how to add one, how hooks work, how cross-session resume works.

**Phase 1 is complete when:** the smoke test passes, the fast-path runbook produces the same artifact set the existing `fast-path.yaml` flow produces, and `CANON_AGENT_TEAMS_MODE=off` is 100% identical to today's behavior (tested by running the existing test suite with the flag off and confirming no diffs).

### Phase 2 — Convert remaining core flows

- Convert `feature`, `refactor`, `migrate`, `test-gap`, `review-only`, `security-audit` flows to runbooks. Each conversion is independent and behind the same feature flag.
- Expand the spawn-prompt module with any domain priming extensions discovered during conversion.
- Extend the smoke-test harness to cover each converted flow.

### Phase 3 — Convert epic (adaptive waves)

Epic is special because it uses adaptive wave planning — the next wave depends on the previous wave's output. In agent-teams terms this maps cleanly to "after wave N finishes, the lead reads the artifacts and decides what teammates to spawn for wave N+1." The runbook format needs to be extended to support branching / conditional spawn steps. Defer design until phases 1 and 2 are stable.

### Phase 4 — Remove deprecated code

After `CANON_AGENT_TEAMS_MODE=on` has been the default for a stable period and no regressions are outstanding:

- Delete `mcp-server/src/features/orchestration/drive-flow.ts` and the state machine runtime.
- Delete wave events plumbing (`inject_wave_event`, `resolve_wave_event`).
- Delete `post_message` / `get_messages` MCP tools (teammate mailbox replaces them).
- Delete `flows/*.yaml` state machine definitions (runbooks replace them).
- Delete `flows/fragments/` if unused by remaining flows.
- Remove `CANON_AGENT_TEAMS_MODE` feature flag. This is the default now.
- Collapse the orchestrator entry point back to a single path.

Expected deletion: approximately 30-40% of `mcp-server/src/features/orchestration/` by line count. Exact number should be measured during the audit in Phase 0.

---

## 7. Phase 1 concrete deliverables (remote session scope)

The remote session executing Phase 1 must produce, on a new branch `canon/agent-teams-phase-1`, the following additions and no deletions:

| Path | Purpose |
|------|---------|
| `docs/coordination-layer-audit.md` | Phase 0 audit output — list every call site of `drive_flow`, `load_flow`, `init_workspace`, `post_message`, `get_messages`, `report_result`, with line numbers and call-count per feature. |
| `mcp-server/src/features/spawn/index.ts` | Spawn prompt assembly library. Exports `assembleSpawnPrompt({ role, task_type, target_files, upstream_artifact_refs, workspace_id })`. |
| `mcp-server/src/features/spawn/README.md` | Library docs. |
| `mcp-server/src/features/spawn/__tests__/assemble-spawn-prompt.test.ts` | Unit tests with fixtures for each Canon role. |
| `mcp-server/src/features/task-list/index.ts` | Read-only wrapper for `~/.claude/tasks/<id>/`. |
| `mcp-server/src/features/task-list/__tests__/` | Tests. |
| `mcp-server/src/features/orchestration/lead-mode.ts` | New orchestrator entry point behind feature flag. |
| `skills/canon/runbooks/fast-path.yaml` | First runbook. |
| `skills/canon/runbooks/README.md` | Runbook format docs and contributor guide. |
| `hooks/canon-agent-teams/hooks.json` | Hook wiring. |
| `hooks/canon-agent-teams/artifact-enforce.sh` | `TaskCompleted` enforcement. |
| `hooks/canon-agent-teams/idle-backstop.sh` | `TeammateIdle` backstop. |
| `hooks/canon-agent-teams/observability.sh` | Event logging. |
| `docs/agent-teams-mode.md` | User docs. |
| `docs/phase-1-smoke-test.md` | Smoke-test run log and artifacts. |

No existing file is deleted in Phase 1. Existing behavior is untouched when `CANON_AGENT_TEAMS_MODE` is unset or `off`.

---

## 8. Validation

Phase 1 is validated by:

1. `npm test` passes in the `mcp-server/` directory with no regressions.
2. `npm run build` in `mcp-server/` has zero TypeScript errors.
3. Running the existing Canon test suite with `CANON_AGENT_TEAMS_MODE` unset produces a diff of zero bytes from baseline behavior.
4. Running the fast-path smoke test with `CANON_AGENT_TEAMS_MODE=on` against a tiny fixture project produces: the four expected artifacts on disk, a clean team teardown (no orphaned state in `~/.claude/teams/`), and a reviewer verdict.
5. The observability hook produces a readable JSONL event stream for the run.

---

## 9. Risks

- **Agent teams is experimental.** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is gated behind an env var, and the docs call out known limitations around session resumption. Mitigation: feature flag, phased rollout, existing flow path preserved.
- **One team per session.** A Canon session running multiple flows sequentially must tear down and rebuild teams between flows. Mitigation: observed to work cleanly in experiment 1; codify in lead-mode as "teardown on flow complete."
- **No nested teams.** The orchestrator cannot spawn a sub-team within a wave. For Phase 1 (fast-path) this doesn't matter. For Phase 3 (epic) it may constrain adaptive wave patterns. Deferred to Phase 3 design.
- **Cross-session resume.** Teammates die with the session; only task list + artifacts survive. The orchestrator must rebuild team state on resume from those sources. Tested design but not yet tested in anger.
- **`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` may be renamed or deprecated.** Pin the experimental status in docs and revisit if Claude Code removes it.

---

## 10. Prerequisites for the remote session

The remote session executing Phase 1 needs:

- Claude Code v2.1.32 or later in its environment (verified as 2.1.98 locally).
- Bash, Node ≥20, npm. Typescript toolchain via `mcp-server/package.json`.
- Read access to this plan document (`docs/agent-teams-migration-plan.md`).
- Read access to the experimental findings captured in section 1.
- Write access to the `canon/agent-teams-phase-1` branch (will be created by the remote session).
- No requirement to modify any existing file during Phase 1.

---

## 11. Out-of-scope for the remote session

- Do not attempt Phase 2, 3, or 4.
- Do not delete, rename, or restructure any existing file.
- Do not modify `drive_flow`, `load_flow`, `init_workspace`, `post_message`, `get_messages`, or any existing orchestration code path.
- Do not modify agent definitions (`agents/*.md`).
- Do not modify flow YAML files (`flows/*.yaml`).
- Do not modify principles or templates.
- Do not commit anything to `main`. All work lands on `canon/agent-teams-phase-1`.
- Do not open a PR. Leave the branch ready for human review.
- If a blocker is discovered that prevents Phase 1 completion, stop, write what you found to `docs/phase-1-blockers.md` on the branch, commit, and exit. Do not improvise beyond the plan.
