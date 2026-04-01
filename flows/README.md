# Canon Flows

Flows are state machines that define Canon's build, review, and security workflows. Each flow is a YAML frontmatter block (states, transitions, constraints) combined with a markdown body (spawn instructions for each state). The orchestrator reads a flow definition, creates a workspace, and drives execution by walking the state graph — spawning specialist agents at each state and transitioning based on their output.

See `SCHEMA.md` for the complete frontmatter reference.

---

## Flows

| Flow | Tier | Description |
|------|------|-------------|
| `refactor` | Medium | Behavior-preserving restructuring with continuous test verification |
| `feature` | Medium (4-10 files) | New feature pipeline |
| `migrate` | Medium | Staged migration with rollback planning and verification |
| `epic` | Large (10+ files) | Research, design, wave implementation, testing, security, review |
| `explore` | Research | Investigate a codebase question — no implementation |
| `test-gap` | Testing | Analyze coverage gaps, write tests, verify, review |
| `review-only` | Review | Review an existing PR or branch without implementing |
| `security-audit` | Security | Dedicated security audit |
| `adopt` | Adoption | Scan for principle violations and auto-fix |

The orchestrator auto-selects the flow based on the tier it detects from the request. You can also request a specific flow explicitly.

---

## Fragments

Fragments are reusable state groups stored in `fragments/`. A flow includes them via the `includes:` field and wires parameters with `with:`. At load time, the orchestrator expands each fragment inline — fragment states become first-class states of the flow.

| Fragment | Purpose |
|----------|---------|
| `implement-verify` | Direct-mode implement then lightweight test verify — fast path for small changes with no plan file |
| `verify-fix-loop` | Run tests (and optionally write new ones when `role: test-writer`), fix implementation bugs, loop until all tests pass |
| `review-fix-loop` | Review code against principles, fix violations via parallel-per fixer, loop until clean. Persists review results to `reviews.jsonl` via drift effects. |
| `context-sync` | Sync documentation after implementation or fix changes (skipped if no contract changes) |
| `security-scan` | Security scan with optional fix loop for critical findings |
| `user-checkpoint` | Pause for user approval or revision feedback before proceeding |
| `ship-done` | Synthesize build artifacts into a PR description and mark the flow complete. |
| `plan-review` | Consultation: architect reviews upcoming wave plans for conflicts and ambiguity |
| `pattern-check` | Consultation: architect reviews wave output for pattern drift and convention inconsistency |
| `early-scan` | Consultation: security quick-scan of wave changes before next wave builds on them |
| `impl-handoff` | Consultation: architect produces implementation overview for downstream test, security, and review agents |

**Including a fragment:**

```yaml
includes:
  - fragment: review-fix-loop
    with:
      after_clean: ship
      after_warning: ship
      max_iterations: 2
```

Fragments declare their expected `params` with defaults (`~` means required). The `with:` map provides values. Fragment states reference params via `${param_name}` in their transition targets and field values.

---

## The Execution Loop

The orchestrator drives a flow with this loop:

1. **`load_flow(flow_name)`** — Parse the flow definition, resolve fragment `includes`, validate that the state graph is acyclic-except-for-known-loops and all transition targets exist.

2. **`init_workspace(task, flow_name)`** — Create `${WORKSPACE}/board.json` (state tracker) and `session.json` (task metadata). On resume, reads the existing board to restore position.

3. **Per state:**
   - `check_convergence(state_id)` — Verify iteration count is within `max_iterations`. If over the limit, escalate to HITL.
   - `update_board(enter_state, state_id)` — Record the state as `in_progress`, increment `entries`.
   - `get_spawn_prompt(state_id)` — Resolve the spawn instruction template: substitute variables (`${task}`, `${WORKSPACE}`, etc.), inject context from prior states, apply wave variables if applicable.
   - Spawn the specialist agent defined by the state.
   - `report_result(state_id, result)` — Record the agent's output, evaluate the transition map, check stuck detection. Returns `next_state`.
   - Repeat for `next_state`.

4. **Terminal state:** `update_board(complete_flow)` — Mark the flow done.

The orchestrator holds no state in its context window between transitions. It reads `board.json`, makes one transition, writes `board.json`. This makes flows fully resumable — if a session restarts mid-flow, the orchestrator reads the board and picks up exactly where it left off.

---

## State Types

### `single`

One agent, runs once per entry. The simplest and most common type.

```yaml
design:
  type: single
  agent: canon-architect
  transitions:
    done: implement
    blocked: hitl
```

### `parallel`

Multiple agents run simultaneously. All must complete before transitioning. When `agents` has one entry and `roles` has multiple entries, the agent is spawned once per role.

```yaml
research:
  type: parallel
  agents: [canon-researcher]
  roles: [codebase, risk]
  transitions:
    done: design
```

Each spawned agent receives a `${role}` variable. Optional roles can be marked `optional: true` — if an optional role fails, the state still proceeds.

### `wave`

Spawns parallel agents across git worktrees, with a gate check between waves. Each task gets an isolated worktree branch so parallel implementors cannot overwrite each other's changes. After all tasks in a wave complete, the orchestrator merges worktree branches back sequentially. If merges conflict, the flow transitions to HITL.

```yaml
implement:
  type: wave
  agent: canon-implementor
  gate: test-suite
  consultations:
    before: [plan-review]
    between: [pattern-check, early-scan]
    after: [impl-handoff]
  transitions:
    done: test
    blocked: hitl
```

The wave tasks and their plan files come from an `INDEX.md` produced by the architect in a prior state. The `gate` field names a verification step (e.g., `test-suite`) run after each wave's merges complete. If the gate fails, the wave transitions to `blocked`.

**Worktree lifecycle:**
1. `git worktree add .canon/worktrees/{task_id} -b canon-wave/{task_id} HEAD`
2. Agent runs in the worktree, commits atomically
3. `git merge --no-ff canon-wave/{task_id}` after all tasks complete
4. `git worktree remove` and `git branch -d` after successful merge

**Wave resume:** If a session restarts mid-wave, the orchestrator checks which tasks have a valid `*-SUMMARY.md` (must contain `### Status` heading with a recognized keyword). Tasks with valid summaries are skipped; the rest are re-spawned.

### `parallel-per`

Fan-out over a dynamic list of items from a prior state's artifact. One agent is spawned per item. Commonly used to fix violations or security findings in parallel.

```yaml
fix-violations:
  type: parallel-per
  agent: canon-fixer
  role: violation-fix
  iterate_on: violation_groups
  max_iterations: 3
  stuck_when: same_violations
  transitions:
    done: review
    cannot_fix: hitl
    blocked: hitl
```

`iterate_on` names a built-in or custom data source parsed from the prior state's artifact. Built-in sources: `violation_groups` (parsed from REVIEW.md violations table) and `security_findings` (parsed from SECURITY.md findings section). Each item is available as `${item}` or `${item.field}` in spawn instructions. Additional optional evidence fields inside a finding, such as `Evidence URLs`, `Verified Facts`, and `Assumptions`, are supporting context and do not change the iterate-on item shape.

If the parsed list is empty, the state transitions immediately to `done` with result `no_items` — no agents are spawned.

---

## Key Flow Concepts

### Convergence

Looping states define an upper bound to prevent infinite retry:

```yaml
review:
  type: single
  agent: canon-reviewer
  max_iterations: 3
  stuck_when: same_violations
```

`max_iterations` caps how many times the state can be re-entered. When the limit is reached, the state escalates to HITL regardless of the normal transition map.

`stuck_when` detects when re-entering a state is producing no progress, triggering early HITL escalation:

| Strategy | Stuck when |
|----------|------------|
| `same_violations` | Same principle IDs + file paths as previous iteration |
| `same_file_test` | Same file + test pair failing as previous iteration |
| `same_status` | Agent returned identical status as previous iteration |
| `no_progress` | No new commits or artifacts since previous iteration |

The orchestrator compares only the two most recent history entries. When stuck is detected, the HITL message includes the strategy that triggered, the current iteration count, and the repeated patterns.

### HITL (Human-in-the-Loop)

Any state can transition to `hitl` — a special pause state that presents the situation to the user. From HITL, the user can:

- **retry** — Re-enter the blocked state from the top
- **skip** — Advance past the blocked state
- **rollback** — Revert recent changes and re-enter an earlier state
- **abort** — Stop the flow entirely
- **manual-fix** — User resolves the issue manually, then resumes

HITL is also the default target when an agent returns an unrecognized status keyword or no status at all.

### User Checkpoints

The `user-checkpoint` fragment pauses the flow and presents a summary of completed work, then waits for the user's response. The `canon-guide` agent uses semantic reasoning to classify the response — it does not look for magic keywords.

- **approved** — User is satisfied, proceed to the next state
- **revise** — User wants changes; feedback is saved to `REVISION-NOTES.md` and routed back for rework

This is used at design review gates in flows like `epic` and `feature`.

### Consultations

Wave states can run lightweight advisory agents at three timing breakpoints, concurrent within each group. Consultation failures are advisory — they log a warning but do not block the flow.

| Breakpoint | When | Output |
|------------|------|--------|
| `before` | Before each wave's worker agents spawn | Folded into `${wave_briefing}` for workers |
| `between` | After wave merge, before gate (not on final wave) | Folded into `${wave_briefing}` for next wave |
| `after` | Once, after the final wave gate passes | Saved as workspace artifact |

Consultation fragments (`plan-review`, `pattern-check`, `early-scan`, `impl-handoff`) are included via `includes:` and referenced by name in the `consultations` map.

### Context Injection

States can pull content from prior states' artifacts or ask the user a question mid-flow:

```yaml
design:
  type: single
  agent: canon-architect
  inject_context:
    - from: research
      section: risk
      as: risk_findings
    - from: user
      prompt: "Any architectural constraints to consider?"
      as: user_constraints
```

`from: <state-id>` reads the state's artifact (optionally scoped to a heading via `section`). `from: user` pauses the flow and presents the prompt. The resolved value is available in the spawn instruction as `${as}`.

### Skip Conditions

States can declare a `skip_when` condition checked before spawning the agent. If the condition is met, the state is skipped with a `done`-like result and no agent is spawned:

| Condition | Skips when |
|-----------|-----------|
| `no_contract_changes` | All changes since last context-sync are internal (no API, types, routes, schema, migrations) |
| `no_fix_requested` | Board metadata has `fix_requested: false` (e.g., `adopt` without `--fix`) |

### Drift Effects

States can declare `effects` — declarative hooks that persist drift data after state completion. Effects parse agent artifacts (REVIEW.md, *-SUMMARY.md) and write to the JSONL drift stores in `.canon/`.

```yaml
review:
  type: single
  agent: canon-reviewer
  effects:
    - type: persist_review
      artifact: REVIEW.md
```

| Effect | Parses | Writes to |
|--------|--------|-----------|
| `persist_review` | REVIEW.md violations, honored, score | `reviews.jsonl` |

Effects are best-effort — failures are logged but never block the flow. In looping states like review, effects run on every iteration so drift reports track improvement across review cycles. See `SCHEMA.md` for the full specification.

### Large Diff Fan-out

Single review states can set `large_diff_threshold` (line count). If the diff exceeds the threshold, the orchestrator automatically fans out parallel reviewers by file cluster instead of running one reviewer on the full diff. The most severe verdict across all clusters becomes the final verdict, and violation tables are merged into a single REVIEW.md.

Clustering strategies: `directory` (top-level directory, the default) or `layer` (architectural layer inferred from path patterns).

---

## Flow File Format

A minimal flow file:

```yaml
---
name: my-flow
description: Example minimal flow
tier: small
entry: implement

includes:
  - fragment: implement-verify
    with:
      after_all_passing: done

states:
  done:
    type: terminal
---

## Spawn Instructions

### implement
Task: ${task}. Implement the change and save a summary to ${WORKSPACE}/plans/${slug}/SUMMARY.md.
```

The YAML frontmatter defines the state graph. The markdown body provides the `### state-id` sections used as prompt templates. Variables like `${task}`, `${WORKSPACE}`, `${slug}`, and `${base_commit}` are substituted by the orchestrator at spawn time.

For the complete field reference — including all state fields, transition conditions, gate contracts, variable catalog, timeout defaults, board schema, and tier mapping — see `SCHEMA.md`.

---

## Creating Flows

To create a new flow, create a `.md` file in `flows/` manually following the format above.

To validate an existing flow (fragment resolution, state reachability, schema correctness), use the `check` flow or review `SCHEMA.md` for the expected format.
