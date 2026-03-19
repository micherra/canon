# Plan: Edge Case Hardening for Canon System

Address all 15 critical/high/medium edge cases across 8 files. Changes are additive — new sections or paragraphs inserted into existing documents, no restructuring.

---

## Change 1: Orchestrator Pre-flight Checks (canon-orchestrator.md)

**File:** `agents/canon-orchestrator.md`
**Location:** New section between Phase 2 (Step 4) and Phase 3 (Step 6)
**What:** Add a "Step 5.5: Pre-flight Validation" section

Add these checks before entering the state machine loop:

1. **Uncommitted changes** — Run `git status --porcelain`. If dirty, warn user: "You have uncommitted changes. Commit or stash before proceeding?" Wait for confirmation.
2. **Detached HEAD** — If `git branch --show-current` returns empty, stop: "Cannot run in detached HEAD state. Check out a branch first."
3. **Active build lock** — Before writing `board.json`, check for `${WORKSPACE}/.lock`. If it exists, read its PID/timestamp. If stale (>2h old), remove it. If fresh, stop: "Another build is active on this branch. Abort it first or wait." On start, write `.lock` with current PID and timestamp. On completion/abort, delete `.lock`.
4. **Flow entry validation** — After loading the flow template, verify that `entry` state exists in the `states` map. If not, report error and stop.

---

## Change 2: Default Transition for Unmatched Status (canon-orchestrator.md)

**File:** `agents/canon-orchestrator.md`
**Location:** Step 9 (Process agent results), after the current transition matching logic
**What:** Add a fallback paragraph

> If no transition condition matches the agent's output status, treat it as `blocked`. Set `states.{id}.status` to `blocked`, record the raw agent output in `states.{id}.error`, and transition to `hitl`. Present the unmatched status to the user so they can decide how to proceed.

---

## Change 3: Board.json Backup on Write (canon-orchestrator.md)

**File:** `agents/canon-orchestrator.md`
**Location:** Phase 3 board protocol (Step 6, items 4 and 8 — every board write)
**What:** Add backup instruction

> Before every write to `board.json`, copy the current file to `board.json.bak`. This ensures that if a write is interrupted mid-operation, the previous valid state can be recovered.

---

## Change 4: Board.json Recovery on Read (canon-orchestrator.md)

**File:** `agents/canon-orchestrator.md`
**Location:** Resumability section
**What:** Add recovery instruction

> When reading `board.json`, if the file is missing or contains invalid JSON, check for `board.json.bak`. If the backup exists and is valid JSON, restore it as `board.json` and log a warning: "Recovered board from backup." If neither file is valid, report to user: "Board state is corrupted. Start fresh or abort?" and wait for HITL decision.

---

## Change 5: Orphan Commit Recovery (canon-orchestrator.md)

**File:** `agents/canon-orchestrator.md`
**Location:** Resume section, after step 3
**What:** Add orphan detection step

> When resuming a state with status `in_progress`, check if the agent committed code but left no summary artifact. Run `git log --oneline -5` and compare commit messages against the task slug. If commits exist for the task but no summary file is present in `states.{id}.artifacts`, note this in the HITL message: "Found commits for this task but no summary. The agent may have crashed after committing. Review the commits and decide: retry the state (agent will see existing code) or mark as done manually."

---

## Change 6: Abort Cleanup and Fresh Start (canon-orchestrator.md)

**File:** `agents/canon-orchestrator.md`
**Location:** Phase 2, Step 4 (Resume logic)
**What:** Extend the resume logic

> If `board.json` exists and `session.json` has `status: "aborted"`, do NOT auto-resume. Instead, ask the user: "Found an aborted build for '{task}'. Resume where it left off, or start fresh?" If fresh: rename `board.json` to `board.aborted.{timestamp}.json`, delete `.lock` if present, and initialize a new board. If resume: set `session.json` status back to `active` and continue from `current_state`.

---

## Change 7: Convention Precedence Rule (canon-implementor.md)

**File:** `agents/canon-implementor.md`
**Location:** Context Isolation section, or as a new subsection
**What:** Add precedence rule

> ### Convention Precedence
>
> When project conventions (CLAUDE.md, .canon/CONVENTIONS.md) conflict with Canon principles:
>
> 1. **Project conventions win for style/structure** — naming, file layout, import style, error handling patterns already established in the codebase.
> 2. **Canon principles win for correctness/safety** — if a principle prevents a bug, security issue, or architectural problem, it takes precedence.
> 3. **Document the conflict** — When you override a convention with a principle (or vice versa), add a JUSTIFIED_DEVIATION in your compliance declaration explaining which rule you followed and why.
>
> Never silently ignore either source. If genuinely unsure, report BLOCKED with the conflict details.

---

## Change 8: Multi-Task Detection in Intake (canon-intake.md)

**File:** `agents/canon-intake.md`
**Location:** "Handling: Build (Triage)" section, before "Triage interview"
**What:** Add a compound request subsection

> ### Compound requests
>
> If the user's input contains multiple independent tasks (e.g., "add auth AND fix the login bug AND refactor the auth module"), split them:
>
> 1. Identify distinct tasks by looking for conjunctions ("and", "also", "plus") separating unrelated actions.
> 2. Present the split: "I see {N} separate tasks: 1) {task-a} 2) {task-b}. I'll handle them one at a time, starting with {task-a}. Sound right?"
> 3. Hand off the first task to the orchestrator. After completion, return to the next task.
>
> Do NOT bundle unrelated work into a single orchestrator handoff — the architect cannot produce a coherent design for unrelated changes.
>
> If tasks are genuinely coupled (e.g., "add auth and protect the existing routes"), treat them as one task.

---

## Change 9: SCHEMA.md — Unmatched Status Default (flows/SCHEMA.md)

**File:** `flows/SCHEMA.md`
**Location:** Transitions section, after the reserved conditions table
**What:** Add a fallback rule

> **Default transition**: If the agent's output contains no recognized status keyword, or if the status keyword has no matching transition in the state's `transitions` map, the orchestrator treats the result as `blocked` and transitions to `hitl`. The raw agent output is recorded in `states.{id}.error` for user review.

---

## Change 10: SCHEMA.md — Artifact Validation (flows/SCHEMA.md)

**File:** `flows/SCHEMA.md`
**Location:** Context Injection section, after resolution rules
**What:** Add validation paragraph

> **Artifact validation**: When resolving `from: <state-id>`, the orchestrator checks that each artifact path in `states.{id}.artifacts` exists on disk. If an artifact is missing, log a warning and exclude it from injection. If ALL artifacts for the source state are missing and the inject is required for the spawn instruction, transition to `hitl` with message: "Required context from {state-id} is missing — artifacts may have been deleted."

---

## Change 11: SCHEMA.md — Wave Resume Semantics (flows/SCHEMA.md)

**File:** `flows/SCHEMA.md`
**Location:** State Types > wave section
**What:** Add resume paragraph after wave description

> **Wave resume**: When resuming a `wave` state with `wave_results.{N}.status = "in_progress"`, the orchestrator checks which tasks in that wave have completed by looking for their summary artifacts in `plans/{slug}/`. Tasks with existing summaries are skipped. Only tasks without summaries are re-spawned. This prevents re-running completed work within an interrupted wave.

---

## Change 12: SCHEMA.md — Parallel State Required vs Optional (flows/SCHEMA.md)

**File:** `flows/SCHEMA.md`
**Location:** Agent Failure Handling section, point 2 (parallel agents)
**What:** Clarify required vs optional

> For parallel agents: all roles are **required** by default. A role is **optional** only if explicitly marked with `optional: true` in the flow's `roles` definition. If any required agent fails, the orchestrator transitions to `hitl`. If only optional agents fail, the orchestrator proceeds with the successful results.

---

## Change 13: Workspace Scoping — Lock File (agent-rules/agent-workspace-scoping.md)

**File:** `agent-rules/agent-workspace-scoping.md`
**Location:** Workspace Structure section (the directory tree)
**What:** Add `.lock` to the tree and a note

Add `.lock` to the workspace directory tree:
```
.canon/workspaces/{sanitized-branch}/
├── .lock              ← build lock (orchestrator-owned)
├── board.json
├── session.json
...
```

> **Build lock**: The `.lock` file prevents concurrent builds on the same branch. Format: `{"pid": "...", "started": "ISO-8601"}`. The orchestrator creates it on start and deletes it on completion or abort. Stale locks (>2 hours old) are automatically removed.

---

## Change 14: Convergence Discipline — Flaky Test Awareness (agent-rules/agent-convergence-discipline.md)

**File:** `agent-rules/agent-convergence-discipline.md`
**Location:** Rules section, after rule 4 (stuck detection)
**What:** Add rule 6

> 6. **Gate retry on ambiguous failure**: When a wave gate fails, the orchestrator re-runs it once before transitioning to `blocked`. If the second run passes, the gate is considered passed. If it fails again with the same error, transition to `blocked`. This handles flaky tests without masking real failures. The retry is logged in `wave_results.{N}.gate_retried: true`.

---

## Change 15: Merge Conflict Prevention in Waves (flows/SCHEMA.md)

**File:** `flows/SCHEMA.md`
**Location:** Gate Contract section, after the built-in gates table
**What:** Add pre-gate check

> **Pre-gate merge check**: Before running the gate command between waves, the orchestrator checks for uncommitted changes or merge conflicts via `git status`. If conflicts exist, the gate is skipped and the wave transitions to `blocked` with reason: "Merge conflict detected between wave tasks. Resolve conflicts before proceeding." This surfaces the real issue instead of showing a confusing test failure.

---

## Summary of files modified

| File | Changes |
|------|---------|
| `agents/canon-orchestrator.md` | Pre-flight checks, default transition fallback, board backup/recovery, orphan commit detection, abort cleanup |
| `agents/canon-intake.md` | Compound request splitting |
| `agents/canon-implementor.md` | Convention precedence rule |
| `flows/SCHEMA.md` | Default transition, artifact validation, wave resume, parallel required/optional, merge conflict pre-check |
| `agent-rules/agent-workspace-scoping.md` | Lock file in tree + docs |
| `agent-rules/agent-convergence-discipline.md` | Gate retry for flaky tests |

Total: **6 files, 15 changes** — all additive, no restructuring.
