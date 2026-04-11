# Canon Agent Teams Mode — User Guide

Status: Phase 1 — foundation only. Read `docs/agent-teams-migration-plan.md` first for the overall plan.

Agent Teams Mode is an alternate execution path for Canon that replaces the custom `drive_flow` state machine with Claude Code's native agent-teams primitive. Phase 1 ships the foundation: a feature-flagged entry point, a spawn-prompt library, a task-list reader, a runbook format, and hooks. No existing behavior changes unless you opt in.

---

## Quick overview

| Today (`drive_flow`) | Agent Teams Mode (`lead-mode.ts`) |
|----------------------|------------------------------------|
| Custom state machine in `features/orchestration/drive-flow.ts` | Runbook walker in `features/orchestration/lead-mode.ts` |
| State transitions enforced by the server | Artifact production enforced by `TaskCompleted` hook |
| Wave events via `post_message`/`get_messages` | Teammate messages via Claude Code's built-in `<teammate-message>` envelopes |
| Flow definitions under `flows/*.md` | Runbooks under `skills/canon/runbooks/*.yaml` |

Today and Agent Teams Mode coexist: the feature flag picks which path runs.

---

## Enabling the mode

1. Use a Claude Code build that supports agent teams. Tested against v2.1.32+ (Phase 1 experiments ran on v2.1.98).
2. Export the two required environment variables in the shell that launches Claude Code:

   ```bash
   export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
   export CANON_AGENT_TEAMS_MODE=on
   ```

   The Claude Code flag unlocks the agent-teams primitive. The Canon flag switches Canon into lead-mode. Both are required.

3. Pin a `CLAUDE_CODE_TASK_LIST_ID` for cross-session resume. Use the convention `deriveTaskListId(workspace_id)` implements in `mcp-server/src/features/orchestration/lead-mode.ts`:

   ```bash
   export CLAUDE_CODE_TASK_LIST_ID=canon-<workspace-id>
   ```

   Without this variable, tasks are ephemeral to the session and resume is unreliable.

4. Install the Canon agent-teams hooks. Phase 1 ships them in an additive directory:

   ```
   hooks/canon-agent-teams/
   ├── hooks.json
   ├── artifact-enforce.sh
   ├── idle-backstop.sh
   └── observability.sh
   ```

   The main `hooks/hooks.json` is unchanged. To load the new hooks alongside the existing ones, either:

   - Merge the two `hooks.json` files into one, **or**
   - Symlink / include `hooks/canon-agent-teams/hooks.json` from your Claude Code settings (if your Claude Code version supports multi-file hook loading).

   Canon does not auto-wire the hooks in Phase 1 because that would modify the existing `hooks.json`.

5. Launch Claude Code from the workspace directory.

---

## What the mode changes

### Runbooks replace flow YAML

When `CANON_AGENT_TEAMS_MODE=on`, the orchestrator reads a runbook from `skills/canon/runbooks/<name>.yaml` instead of a flow definition from `flows/<name>.md`.

Phase 1 ships a single runbook: `fast-path.yaml`. Phase 2 will add the remaining core flows. See `skills/canon/runbooks/README.md` for the runbook schema.

### Spawn prompts come from one place

All teammate context assembly flows through `mcp-server/src/domains/spawn/`. The lead passes role, task type, target files, upstream artifacts, and workspace id to `assembleSpawnPrompt`, which returns a deterministic prompt string. There is no hook-based context injection for teammates — Claude Code teammate sessions do not observe `UserPromptSubmit` or `SessionStart` hooks, so the spawn prompt is the only channel.

### Artifacts are enforced by a hook

`artifact-enforce.sh` runs on `TaskCompleted`. It looks up the expected artifact path from `.canon/workspaces/<id>/agent-teams/task-artifacts.json` and blocks completion with exit 2 if the artifact is missing or empty. The lead-mode orchestrator writes this state file at spawn time via `writeTaskArtifactState`.

### Idle teammates get a backstop

`idle-backstop.sh` runs on `TeammateIdle`. If the idle teammate's expected artifact (looked up from `teammate-artifacts.json`) is missing, it emits feedback and exits 2 so the lead is nudged to re-prompt rather than letting the teammate drop silent.

### Observability JSONL stream

`observability.sh` runs on `SubagentStart`, `SubagentStop`, `TeammateIdle`, and `TaskCompleted`. Each call appends one JSONL line to `.canon/workspaces/<id>/events.jsonl` for post-hoc analysis and drift tracking. It is advisory only and never blocks.

---

## Cross-session resume

Phase 1 relies on two on-disk substrates for resume:

1. **On-disk artifacts** under `.canon/workspaces/<id>/` — the exact same files the drive_flow path writes today. Research syntheses, plan indexes, implementation summaries, and reviews all have stable paths described by the runbook.
2. **The pinned task list** at `~/.claude/tasks/<CLAUDE_CODE_TASK_LIST_ID>/` — persists across sessions. The read side is in `mcp-server/src/domains/task-list/`.

On resume, lead-mode reads the pinned task list to see which tasks are still pending, cross-references against the artifact state file, and walks the remaining runbook steps. The server-side entry point is `filterPendingDescriptors(descriptors, taskListOptions)` in `mcp-server/src/features/orchestration/lead-mode.ts`: given the descriptor list returned by `planRun` and the pinned task list, it returns only the descriptors whose tasks are not yet marked `completed`. Entries with status `pending`, `in_progress`, `blocked`, or anything else are treated as still needing work. If the task list is empty or `CLAUDE_CODE_TASK_LIST_ID` is unset, every descriptor is returned — matching the "first run" semantics.

---

## Failure modes and fallback

The mode is fully opt-in. To revert:

- Unset `CANON_AGENT_TEAMS_MODE` (or set it to anything other than `on`).
- Canon falls back to `drive_flow` automatically on the next session.

If Phase 1 hits a bug, file an issue with the relevant JSONL events from `.canon/workspaces/<id>/events.jsonl` attached. In the meantime the escape hatch above restores the existing, validated path.

---

## Adding a new runbook

1. Create `skills/canon/runbooks/<name>.yaml`. Follow the schema in `skills/canon/runbooks/README.md`.
2. Match the steps to existing Canon agent definitions in `agents/*.md` — Phase 1 reuses all 13 agents unchanged.
3. Keep the `artifact` and `artifact_path` fields aligned with the canonical contract in `mcp-server/src/domains/spawn/index.ts` (`ROLE_ARTIFACT_CONTRACTS`). `planRun` will throw at load time if the two diverge.
4. Run the smoke-test procedure in `docs/phase-1-smoke-test.md` with your new runbook.
5. Submit the runbook plus any required fixture updates in a single change.

---

## Debugging tips

- **Nothing happens when I type a build request.** Confirm both `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `CANON_AGENT_TEAMS_MODE=on` are set in the session's shell. Claude Code caches env, so restart the session after changing them.
- **`TaskCompleted` blocks me and I don't know why.** Look at the hook's stderr output — it prints the expected artifact path. Check `.canon/workspaces/<id>/agent-teams/task-artifacts.json` to verify the lead registered the task.
- **Teammates never produce an artifact.** Check `idle-backstop.sh` output in the lead's transcript. The backstop surfaces the expected path the teammate was meant to produce.
- **Resume loses my state.** Confirm `CLAUDE_CODE_TASK_LIST_ID` was set the same way in both sessions and that `~/.claude/tasks/<id>/` is present.

---

## What stays the same

Agent Teams Mode does not change:

- Canon principles, rules, conventions, or drift tracking.
- Agent definitions in `agents/*.md` (all 13 are reused verbatim).
- Artifact schemas or storage layout under `.canon/workspaces/<id>/`.
- Single-agent tools (`canon-chat`, `canon-guide`, `canon-writer`, `canon-learner`) — these never used waves and do not benefit from agent teams.
- The existing `flows/*.md` files, which are still consumed by `drive_flow` when the flag is off.

---

## See also

- `docs/agent-teams-migration-plan.md` — full plan and phased rollout.
- `docs/coordination-layer-audit.md` — Phase 0 audit of the code that Phase 4 will eventually delete.
- `docs/phase-1-smoke-test.md` — smoke-test log for the Phase 1 drop.
- `skills/canon/runbooks/README.md` — runbook format reference.
- `mcp-server/src/domains/spawn/README.md` — spawn-prompt library API.
