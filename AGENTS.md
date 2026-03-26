# Canon Cursor Runner (Cursor-only)

This project contains Canon’s “engineering principles as code” system, including:
- A flow/state-machine specification (`flows/*.md`) with reusable fragments (`flows/fragments/*.md`)
- Specialist role implementations as prompt specs (`agents/*.md`)
- Canon MCP tools (`mcp-server/src/index.ts`), wired to Cursor via `.cursor/mcp.json`

This file defines the Cursor-side runtime so users can execute the full Canon pipeline **without installing the Claude Code plugin**.

## Activation

Only run the Canon pipeline when ALL of the following are true:
1. The user’s message matches a Canon intent (build/review/security/resume/status/principle/learn) OR `.canon/` exists in the repository.
2. The user is requesting an action that requires the pipeline (not just a generic question).
3. The user has not explicitly asked for “no Canon” behavior.

When uncertain, ask one clarifying question.

## Canon Intake (intent classification + handoff)

Classify the user intent using the same categories as Canon Intake:
- **build**: “create/add/implement/build/refactor/migrate …”
- **review**: “review/check my changes/review PR …/review staged …”
- **security**: “security scan/audit for vulnerabilities”
- **learn**: “analyze patterns/check conventions/what should we improve”
- **resume**: “continue/pick up where we left off/resume”
- **status**: “where are we/show progress/dashboard”
- **principle**: “create a principle/new rule/new agent-rule/agent rule”
- **question/chat**: answer directly (do not run flows)

If the user message is ambiguous, ask one question to choose between the most likely “build vs question/review vs security”.

### Build handoff contract

If intent is `build`, construct the handoff object the rest of the pipeline will use:
```text
Task: {the user’s task, with flags removed if present}
Flow: {explicit flow from --flow, otherwise selected by tier}
Resume: {true if user said resume or if board.json exists and is not terminal}
Skip flags: ["research"|"tests"|"security"] (from --skip-* if provided)
Plan only: {true if --plan-only is set}
Tier override: {small|medium|large} (from --tier if provided)
Review scope: (only for review-only flows)
```

### Flag parsing (supported)

Recognize these modifiers:
- `--flow <name>` → force `flow: <name>`
- `--skip-research` → `skip_flags: ["research"]`
- `--skip-tests` → `skip_flags: ["tests"]`
- `--skip-security` → `skip_flags: ["security"]`
- `--plan-only` → `plan_only: true`
- `--review-only` → `flow: review-only`
- `--wave N` → `resume_wave: N`
- `--tier small|medium|large` → `tier_override`

If the user uses natural language like “skip tests / just plan”, infer the matching flags.

## Flow selection (tier → flow name)

Compute task tier using Canon’s heuristic:
- **small**: likely 1-3 files, single concern
- **medium**: likely 4-10 files, single feature
- **large**: likely 10+ files, cross-cutting, needs architecture

Before proceeding, present: `Detected tier: {tier} → flow: {flow}` and ask for “Proceed?” only if the tier is ambiguous.

Default tier→flow mapping:
- small → `quick-fix`
- medium → `feature`
- large → `deep-build`

## Workspace initialization and board protocol

The flow runner must be resumable and must use Canon’s disk state as the single source of truth.

### Workspace path + branch sanitation

1. Determine current branch:
   - Run `git branch --show-current`
   - If empty, stop: “Cannot run in detached HEAD state. Check out a branch first.”
2. Sanitize branch name into `{sanitized}`:
   - Replace `/` with `--`
   - Replace spaces with `-`
   - Strip non-alphanumeric characters except `-`
   - Lowercase
   - Truncate to 80 chars
3. Workspace path is: `.canon/workspaces/{sanitized}/`

### Locking + pre-flight checks

Run:
- `git status --porcelain`
  - If uncommitted output exists, warn and ask whether to proceed.
- Lock check:
  - If `.canon/workspaces/{sanitized}/.lock` exists, read its JSON and:
    - If `started` is older than 2 hours, treat as stale and remove it.
    - Otherwise stop: another build is active; ask user to abort or wait.
  - On passing: write `.lock` with `{pid, started}`.

### File layout

Ensure the workspace includes:
- `session.json`
- `board.json`
- `progress.md` (if flow has `progress`)
- `log.jsonl`
- `research/`, `decisions/`, `plans/`, `reviews/`, `notes/` folders

Initialize `session.json` and `board.json` to match Canon’s structure.
Refer to:
- Flow initialization + board schema: `agents/canon-orchestrator.md`
- State machine schema: `flows/SCHEMA.md`

## State machine execution loop

This is the Cursor-side equivalent of `canon-orchestrator`:

### Step A: Load the flow template

Read the flow template:
- `flows/{flow-name}.md`

Parse:
- top-level flow frontmatter (`name`, `tier`, `progress`, `includes`, etc.)
- `states:` map for state IDs, state types, agent names, templates, transitions, and settings (like `max_iterations`, `stuck_when`, `gate`)
- spawn instructions from the markdown bodies:
  - each `### state-id` section is the agent prompt for that state

**Fragment resolution**: If the flow has an `includes:` list, resolve fragments before walking the state machine:
1. For each include, read `flows/fragments/{fragment}.md`
2. Validate required params are provided in `with:`
3. Substitute `${param}` values in the fragment's state definitions
4. Apply `as:` rename and `overrides:` shallow merge if specified
5. Merge fragment states into the flow's state map and append fragment spawn instructions
6. After resolution, the merged flow looks like a monolithic file — proceed normally

See `flows/SCHEMA.md` for the full fragment specification.

### Step B: Determine current state

If `resume: true` OR `board.json` exists:
- Read `board.json`
- Read `session.json`
- Set the runner entrypoint to:
  - `board.current_state` (if not terminal)
- If `session.json.status === "aborted"`, ask whether to resume or start fresh.

### Step C: For each state

Repeat until the current state is `terminal`:
1. Read `board.json`
2. Apply conditional skip logic:
   - If skip flags include the state’s phase, mark state skipped and follow the done-like transition.
   - If `skip_when` is set (especially `no_contract_changes`), evaluate before spawning.
     - For `no_contract_changes`: check `git diff --name-only {base}..HEAD` and compare against contract patterns:
       `**/index.ts`, `**/api/**`, `**/routes/**`, `**/types/**`, `**/schema*`, `**/public/**`, `package.json`, `**/migrations/**`.
3. Update board:
   - set `current_state = {id}`
   - set `states.{id}.status = "in_progress"`
   - increment `entries`, set `entered_at`, and write `board.json`
4. Execute the state by role emulation:
   - Construct the resolved spawn prompt from the flow template:
     - Read the `### {state-id}` section from the flow’s markdown body or from the fragment’s markdown body (after fragment resolution, all spawn instructions are available — inline states have their prompts in the flow file, fragment states have theirs in the fragment file)
     - Substitute variables conceptually (e.g. `${task}`, `${WORKSPACE}`, `${slug}`, `${task_id}`, `${base_commit}`, and any injected context)
   - Invoke the matching specialist subagent in *foreground*:
     - Subagent name must equal `state.agent` (e.g. `canon-architect`, `canon-implementor`, `canon-tester`, `canon-security`, `canon-reviewer`, `canon-fixer`, `canon-scribe`, `canon-researcher`, `canon-shipper`)
     - Use explicit subagent invocation syntax: `/{state.agent}`
   - Paste the resolved spawn prompt into the subagent invocation request as the primary instruction.
5. Parse the specialist output for a status keyword:
   - First look for a `STATUS:` line (recommended) and use its value
   - Otherwise, search the output for the recognized status keywords described in `flows/SCHEMA.md` (DONE, BLOCKED, NEEDS_CONTEXT, CLEAN, WARNING, BLOCKING, IMPLEMENTATION_ISSUE, CANNOT_FIX, FIXED, PARTIAL_FIX, ALL_PASSING, etc.)
   - Map the status keyword to the configured transition condition (also defined in `flows/SCHEMA.md`)
6. Update board accordingly:
   - If successful: set `states.{id}.status = done`, store `result`, store `artifacts`, and write `completed_at`
   - If blocked/failed/unrecognized: set `states.{id}.status = blocked`, set `states.{id}.error`, and transition to `hitl`
7. Append:
   - to `progress.md` (one-line summary) if configured
   - to `log.jsonl` with `state`, `agent`, `model`, `duration_ms`, and spawn counts

## Wave worktree isolation (used by `type: wave` states)

When the flow state is `type: wave`, you must preserve Canon’s isolation discipline using git worktrees (even if true parallel execution is not available in Cursor).

### Inputs
- Current flow state id (e.g. `implement`)
- Current `${slug}`
- Workspace path: `${WORKSPACE}`
- Plan index for the task: `${WORKSPACE}/plans/${slug}/INDEX.md`

### Built-in behavior to follow
Match the semantics described in `flows/SCHEMA.md` for:
- worktree creation per task
- wave briefing injection (if configured)
- merging worktree branches back sequentially
- cleanup
- gate verification between waves

### Execution algorithm (per wave)

1. Parse wave tasks
   - Read `${WORKSPACE}/plans/${slug}/INDEX.md`
   - Group tasks by `Wave` column into waves ordered numerically
   - If resuming from a specific wave (from the build handoff’s `resume_wave`), start at that wave and skip earlier waves

2. For each wave number `W` (in order):
   1. Worktree creation for each task `task_id` in wave `W`:
      - Create worktree branch:
        - `git worktree add .canon/worktrees/{task_id} -b canon-wave/{task_id} HEAD`
      - Ensure the worktree directory exists and is usable.
   2. Execute implementor in each worktree
      - Cursor may not run fully parallel jobs; execute tasks one-by-one but still inside their worktree directories.
      - For each task:
     - Invoke the specialist subagent `/canon-implementor` in *foreground*.
     - Provide explicit worktree context to the subagent:
       - `WORKTREE_ROOT=.canon/worktrees/{task_id}`
       - `REPO_ROOT_FOR_CODE_EDITS=$WORKTREE_ROOT` (so all code edits happen inside the worktree, not the main branch)
       - Run all `git` commands with working directory set to `$WORKTREE_ROOT`.
     - The subagent’s primary instruction should be the resolved implement spawn prompt for:
       `${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md`
     - Ensure all reads/writes for code and test edits target `$WORKTREE_ROOT`’s filesystem
        - Run verification steps required by the implementor (and by the flow state if it adds extra checks)
        - Commit atomically within the worktree branch (git commit created on `canon-wave/{task_id}`)
   3. Merge worktrees back sequentially
      - For each `task_id` in wave `W`:
        - `git merge --no-ff canon-wave/{task_id} -m "merge: {task_id}"`
      - If any merge conflicts occur:
        - Record the conflicting `task_id`s
        - Stop the pipeline and transition to `hitl` (manual conflict resolution)
   4. Cleanup
      - After successful merges for the wave:
        - `git worktree remove .canon/worktrees/{task_id}`
        - `git branch -d canon-wave/{task_id}`
   5. Gate verification between waves
      - If the flow state specifies `gate: test-suite`:
        - Run the project test command (auto-detect from `package.json` scripts.test, then fallback to common conventions like `npm test`)
      - If the gate fails:
        - Treat this wave as `blocked` and transition to `hitl`

### Conflict + HITL contract
If a worktree merge produces conflicts, your HITL message must:
1. Name the state id (e.g. `implement`)
2. List conflicting tasks
3. Show the safe rollback point from `board.base_commit`

## HITL behavior and rollback (interactive + resumable)

When the runner transitions to `hitl`, it must both:
1. Update Canon’s external state on disk (`board.json`, and sometimes `session.json`)
2. Present an explicit choice to the user (so the pipeline can continue deterministically)

### Step 1: Update `board.json`

Set:
- `blocked = { "state": "{state-id}", "reason": "{why}", "since": "{ISO-8601}" }`
- Write `board.json`

### Step 2: Present HITL to the user

In the chat, present:
1. The blocking state id (the current `hitl` state)
2. The reason text from the runner
3. The iteration count (if the flow uses loops)
4. Stuck detection history (if applicable)
5. The safe rollback point:
   - `base_commit` from `board.json`

### Step 3: Offer options (Canon HITL)

Ask the user to choose ONE option:
1. `retry`: re-enter the blocked state (reset `blocked` to null)
2. `skip`: mark the blocked state as `skipped` and transition using the state’s first done-like transition
3. `rollback`: destructive revert of all build commits back to `base_commit`
4. `abort`: stop the pipeline, set `session.json.status = "aborted"` (changes remain in the workspace/working tree)
5. `manual-fix`: user fixes the issue themselves, then the user says “resume” (runner continues)

### Step 4: On user response

#### Option: `retry`
- Set `blocked = null`
- Write `board.json`
- Continue from the same state id

#### Option: `skip`
- Set `states.{state-id}.status = "skipped"`
- Clear `blocked`
- Write `board.json`
- Follow the configured `done`-like transition

#### Option: `abort`
- Set `session.json.status = "aborted"`
- Write `session.json`
- Remove `.lock` if it exists
- Stop the pipeline

#### Option: `manual-fix`
- Do NOT rewrite code automatically
- Clear `blocked` and keep board state consistent (so resuming re-enters the same state)
- Continue only when the user later resumes

#### Option: `rollback` (destructive)

Rollback must follow the Canon rollback protocol:

1. Read `base_commit` from `board.json`
2. Show the user what will be reverted:
   - `git log --oneline {base_commit}..HEAD`
3. Ask for a confirmation explicitly (rollback can destroy work).
4. On confirmation:
   - Run:
     - `git revert --no-commit {base_commit}..HEAD`
     - `git commit -m "rollback: revert build for '{task}' back to {base_commit}"`
   - If `git revert` produces conflicts:
     - report conflicts and suggest an emergency fallback:
       - `git reset --hard {base_commit}`
     - (with an explicit warning about data loss)
5. Update `session.json`:
   - set status to `"rolled_back"`
   - set `rolled_back_at`
   - set `rolled_back_to: {base_commit}`
6. Remove `.lock` if present
7. Log the rollback event to `${WORKSPACE}/log.jsonl`:
   - `{"timestamp": "...", "agent": "canon-orchestrator", "action": "rollback", "detail": "Reverted to {base_commit}"}`
8. Stop or resume based on the user’s follow-up (ask user).


## Specialist role dispatch (per-state contracts + artifact paths)

For a given flow state:
1. Read the flow’s state config (state type, configured `agent`, configured `template`, and other settings like `role: fix`).
2. Emulate the configured specialist agent by following the corresponding process contract in `agents/canon-<role>.md`.
3. Write artifacts to the exact filesystem paths referenced by the flow’s spawn instructions (placeholders resolved as described below).
4. Return a final status keyword so the runner can map it to the configured transition.

### Placeholder resolution

Within flow spawn instructions and required artifact paths:
- `${WORKSPACE}` is `.canon/workspaces/{sanitized}/`
- `${slug}` is the task slug from `session.json` (the sanitized task id)
- `${task_id}` is the current wave task id from `plans/${slug}/INDEX.md` (only for wave states)
- `${base_commit}` is `board.base_commit`
- `${CLAUDE_PLUGIN_ROOT}` in the flow specs is effectively the repo root when running Cursor-only

### Output templates

When a flow state specifies `template: <name>` (or template list), you must:
1. Read `templates/<name>.md`
2. Follow its structure exactly when writing the required artifact.

### Role contract cheat-sheet (what to read/write)

#### `canon-researcher` (used in `deep-build` research state)
- Reads: task + assigned research dimension instructions + relevant Canon context.
- Writes:
  - In `deep-build`, the state prompt specifies: `${WORKSPACE}/research/${role}.md`
    where `${role}` is one of `codebase`, `risk`.
- Status keyword: one of the standard completion statuses (e.g. `DONE` / `BLOCKED` / `NEEDS_CONTEXT`).

#### `canon-architect` (used in `feature` + `deep-build` design state)
- Reads:
  - merged research findings from `${WORKSPACE}/research/` (especially `${WORKSPACE}/research/risk.md` if present)
  - relevant Canon principles (via `get_principles`)
  - `.canon/CONVENTIONS.md` if present and `CLAUDE.md`
- Writes (exact paths as required by flow prompts):
  - Design doc: `${WORKSPACE}/plans/${slug}/DESIGN.md`
  - Plans index: `${WORKSPACE}/plans/${slug}/INDEX.md`
  - Per-task plans: `${WORKSPACE}/plans/${slug}/${task_id}-PLAN.md`
  - Decisions: `${WORKSPACE}/decisions/{decision-id}.md`
  - Workspace context: `${WORKSPACE}/context.md`
- Status keyword: `DONE` / `HAS_QUESTIONS` / `BLOCKED` / `NEEDS_CONTEXT`.

#### `canon-implementor` (used in all “implement” states)
- **Plan/normal mode only** — executes a plan file and writes summaries.
- Writes (exact paths as required by flow prompts):
  - Wave states: Summary: `${WORKSPACE}/plans/${slug}/${task_id}-SUMMARY.md`
  - Quick-fix direct implement: Summary: `${WORKSPACE}/plans/${slug}/SUMMARY.md`
- Verification:
  - Must run the flow’s verification steps (typically full test suite per plans/SCHEMA).
- Status keyword:
  - `DONE` (or `DONE_WITH_CONCERNS`)
  - `BLOCKED` / `NEEDS_CONTEXT`

#### `canon-tester` (used in `test` state, and lightweight `verify` in `quick-fix`)
- Reads:
  - task coverage notes and implementor summaries from `${WORKSPACE}/plans/${slug}/*-SUMMARY.md`
- Writes (exact paths):
  - Test report: `${WORKSPACE}/plans/${slug}/TEST-REPORT.md`
- Flow-specific override:
  - In `quick-fix`, the `verify` spawn instructions say: run the project test suite only and do NOT write new tests.
    If the role spec conflicts, treat the flow spawn instructions as higher priority for this state.
- Status keyword:
  - `ALL_PASSING` / `IMPLEMENTATION_ISSUE` / `BLOCKED`.

#### `canon-security` (used in `deep-build` `security` state, and `security-audit` security state)
- Writes:
  - Security assessment:
    - `${WORKSPACE}/plans/${slug}/SECURITY.md`
- Uses `list_principles` filtered by `security` tag (as per role spec).
- Status keyword:
  - `CLEAN` / `FINDINGS` / `CRITICAL` (mapped by transitions in the flow).

#### `canon-reviewer` (used in `feature/deep-build` `review` state, plus `review-only` review state)
- Writes:
  - Review checklist:
    - `${WORKSPACE}/plans/${slug}/REVIEW.md`
  - Plus a copy:
    - `${WORKSPACE}/reviews/` (as required by flow spawn instructions)
- Must evaluate Stage 1 (principle compliance) and Stage 2 (code quality through the lens of principles) as described in the role spec.
- Status keyword:
  - `CLEAN` / `WARNING` / `BLOCKING` (or `BLOCKED` for failures requiring HITL).

#### `canon-fixer` (used in `fix-impl`, `fix-security`, and `fix-violations`)
- Two modes:
  - **test-fix** (`role: test-fix`): reads TEST-REPORT.md, fixes source bugs and flags test bugs, writes FIX-SUMMARY.md.
  - **violation-fix** (`role: violation-fix`): reads violation details from `${item.*}` fields, refactors to comply with Canon principles.
- Writes:
  - test-fix mode: `${WORKSPACE}/plans/${slug}/FIX-SUMMARY.md`
  - violation-fix mode: artifact-light — commits fixes atomically.
- Status keyword:
  - test-fix: `DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT`
  - violation-fix: `FIXED` / `PARTIAL_FIX` / `CANNOT_FIX` / `BLOCKED` / `NEEDS_CONTEXT`

#### `canon-scribe` (used in context-sync stages)
- Writes:
  - `${WORKSPACE}/plans/${slug}/CONTEXT-SYNC.md` (normal context sync)
  - `${WORKSPACE}/plans/${slug}/CONTEXT-SYNC-FIX.md` (post-fix sync)
- Updates docs only when the contract surface changes (NO_UPDATES vs UPDATED).
- Status keyword:
  - `UPDATED` / `NO_UPDATES` (mapped by the flow’s transitions).

#### `canon-shipper` (used in `ship` state in build flows)
- Reads:
  - `session.json`, `board.json`, all `*-SUMMARY.md`, `TEST-REPORT.md`, `REVIEW.md`, `SECURITY.md`, `DESIGN.md`
- Writes:
  - PR description: `${WORKSPACE}/plans/${slug}/PR-DESCRIPTION.md`
  - Optionally creates PR via `gh pr create`
  - Optionally appends to `CHANGELOG.md`
- Status keyword:
  - `DONE` / `DONE_WITH_CONCERNS` / `BLOCKED`

#### `canon-writer` and `canon-learner` (used for principle/learn intents, not the main build flows)
- Principle creation/edit:
  - `canon-writer` writes into `.canon/principles/**` or `.canon/agent-rules/**` depending on the mode.
- Learning:
  - `canon-learner` writes `.canon/LEARNING-REPORT.md` and appends to `.canon/learning.jsonl`.

### Flow-specific state mapping (supported flows)

#### `deep-build` state map
Inline states:
- `research` (parallel): `canon-researcher` -> `${WORKSPACE}/research/${role}.md` (role = codebase|risk)
- `design` (single): `canon-architect` -> `plans/${slug}/DESIGN.md`, `plans/${slug}/${task_id}-PLAN.md`, `plans/${slug}/INDEX.md`, `decisions/`, `context.md`
- `implement` (wave): `canon-implementor` -> `plans/${slug}/${task_id}-SUMMARY.md`
- `security` (single): `canon-security` -> `plans/${slug}/SECURITY.md`
- `fix-security` (parallel-per): `canon-fixer` (violation-fix) -> git commits + FIXED/PARTIAL_FIX/CANNOT_FIX

From fragments:
- `context-sync` (from `context-sync` fragment, next → test)
- `test`, `fix-impl`, `context-sync-fix` (from `test-fix-loop` fragment, after_all_passing → security)
- `review`, `fix-violations` (from `review-fix-loop` fragment, after_clean/warning → ship, + large_diff_threshold override)
- `ship`, `done` (from `ship-done` fragment)

#### `feature` state map
Inline states:
- `design` (single): `canon-architect` -> same artifacts as deep-build
- `implement` (wave): `canon-implementor` -> `plans/${slug}/${task_id}-SUMMARY.md`

From fragments:
- `context-sync` (from `context-sync` fragment, next → test)
- `test`, `fix-impl`, `context-sync-fix` (from `test-fix-loop` fragment, after_all_passing → review)
- `review`, `fix-violations` (from `review-fix-loop` fragment, after_clean/warning → ship)
- `ship`, `done` (from `ship-done` fragment)

#### `quick-fix` state map
Inline states:
- `implement` (single, direct mode): `canon-implementor` -> `plans/${slug}/SUMMARY.md`
- `verify` (single): `canon-tester` (run test suite only, do not write new tests) -> `plans/${slug}/TEST-REPORT.md`

From fragments:
- `context-sync` (from `context-sync` fragment, next → review)
- `review`, `fix-violations` (from `review-fix-loop` fragment, after_clean/warning → ship, max_iterations: 2)
- `ship`, `done` (from `ship-done` fragment)

#### `review-only` state map (no fragments)
- `review` (single): `canon-reviewer` -> `plans/${slug}/REVIEW.md` and `reviews/`
  - `large_diff_threshold: 300`, `cluster_by: layer` — auto-fans out parallel reviewers by architectural layer for large diffs
  - Scope controlled by `${review_scope}` from orchestrator input contract

#### `adopt` state map (no fragments)
- `scan` (single): `canon-researcher` (role: adoption-scan) -> `plans/${slug}/ADOPTION-REPORT.md`
- `fix` (parallel-per): `canon-fixer` (role: violation-fix) -> git commits (skipped if `no_fix_requested`)
- `rescan` (single): `canon-researcher` (role: adoption-scan) -> updated `plans/${slug}/ADOPTION-REPORT.md`

#### `security-audit` state map (no fragments)
- `security` (single): `canon-security` -> `plans/${slug}/SECURITY.md`
- `review` (single): `canon-reviewer` -> `plans/${slug}/REVIEW.md` and `reviews/`

## Inline mode principle enforcement (filled in by later to-dos)

When the user asks for direct code edits outside a build pipeline (for example, “edit this file directly” without triggering a flow), enforce Canon principles inline.

### Inline mode rules

1. Identify the file paths you will modify (or create).
2. For each file path, call the MCP tool `get_principles` with:
   - `file_path`: that file path
   - (optionally) `summary_only: true` for the initial pass to reduce context
3. Apply every loaded principle’s guidance:
   - `rule` severity is non-negotiable: if the change would violate it, you must fix the code (do not proceed).
   - `strong-opinion`:
     - default path is to follow it
     - if you must deviate, you must clearly justify why it is acceptable for this project and record the deviation (if the `report` tool is available, log it as `type=decision`).
   - `convention`:
     - follow when possible
     - deviations are “noted” but must not turn into `rule` violations.
4. After code edits are generated, run a self-review step:
   - re-check each loaded principle against the final code you produced
   - ensure there is no remaining violation of `rule`-severity constraints
5. Before presenting the final output to the user, include a brief compliance note:
   - which principles were loaded
   - whether any deviations were justified (and why)

## Developer references for the runner

Use these files as the source of truth (read them as needed):
- `agents/canon-orchestrator.md`
- `flows/SCHEMA.md`
- `flows/{flow-name}.md`
- `flows/fragments/{fragment-name}.md`
- `agents/canon-*.md`

