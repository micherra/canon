---
task_id: "phase1-01"
wave: 1
depends_on:
  - "phase1-00"
files:
  - skills/canon/runbooks/fast-path.md
principles:
  - agent-plans-are-prompts
domains:
  - orchestration
---

## Task: Create fast-path runbook

### Action

Create `skills/canon/runbooks/fast-path.md` conforming to `_template.md`. This is the simplest runbook — single-agent, no research, no architecture, no waves.

1. Read `flows/fast-path.md` for the legacy state machine definition. The flow has these states:
   - `execute` (single, canon-engineer) — implement, test, self-review, commit
   - `pre-launch-check` (single, no agent) — run discovered quality gates
   - `ship` (single, canon-shipper) — synthesize PR description
   - `learn` (single, canon-learner, skip_when: learn_gate_not_passed) — auto-trigger pattern analysis

2. Read `_template.md` for the field reference.

3. Write `fast-path.md` with:

```yaml
name: "fast-path"
description: "Single-agent fast path — implement, test, self-review in one pass"
tier: "small"

steps:
  - id: "execute"
    agent: "canon-engineer"
    dispatch: "subagent"
    mcp_tools:
      - get_principles
      - get_file_context
      - init_workspace
      - log_step
    artifacts:
      - "plans/${slug}/SUMMARY.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      FAST PATH — single-agent mode. The implementor handles implementation
      (TDD), test verification, self-review against Canon principles, and commit.
      Summary MUST include a ### Self-Review section with Canon principle
      compliance declarations and a ### Verification section confirming all
      tests pass.

  - id: "pre-launch-check"
    agent: null
    dispatch: "subagent"
    mcp_tools:
      - log_step
    artifacts: []
    hitl: "on_failure"
    skip_when: null
    notes: |
      Gate-only step — no agent spawned. The lead collects all discovered
      quality-check commands (test, lint, build) from the execute step's
      summary and runs them via Bash. If all pass, proceed. If any fail,
      present to user. If no gates discovered, fail closed.

  - id: "ship"
    agent: "canon-shipper"
    dispatch: "subagent"
    mcp_tools:
      - log_step
      - update_board
    artifacts:
      - "plans/${slug}/PR-DESCRIPTION.md"
    hitl: "on_failure"
    skip_when: null
    notes: |
      Synthesize build artifacts into PR description. Reads session.json,
      board.json, SUMMARY.md. Runs git log for commit history. Checks
      CHANGELOG.md for format detection.

  - id: "learn"
    agent: "canon-learner"
    dispatch: "subagent"
    mcp_tools:
      - log_step
      - get_drift_report
    artifacts: []
    hitl: "none"
    skip_when: "learn_gate_not_passed"
    notes: |
      Auto-trigger mode. Analyze transcripts and drift data to propose
      principle/convention updates. Skip if learn gate evaluation fails.
```

4. Validate the file matches the schema structure from `_template.md`.

### Canon principles to apply
- **agent-plans-are-prompts**: The `notes` field for each step IS the spawn guidance. It must be actionable — not a restatement of the agent definition, but specific instructions for this flow context.

### Tests to write
- No code tests. YAML validation only.

### Verify
1. File exists at `skills/canon/runbooks/fast-path.md`
2. File parses as valid YAML
3. Steps cover all 4 states from `flows/fast-path.md`: execute, pre-launch-check, ship, learn
4. Every step has all required fields per `_template.md`
5. `npm run build` passes (no TypeScript changes)
6. `npm test` passes (no test changes)

### Done when
- `fast-path.md` exists and parses as valid YAML
- All 4 legacy states are represented as steps with correct agents, dispatch types, and artifacts
- The `notes` for `execute` includes the self-review and verification requirements from the legacy spawn instructions
- Build and tests pass unchanged
