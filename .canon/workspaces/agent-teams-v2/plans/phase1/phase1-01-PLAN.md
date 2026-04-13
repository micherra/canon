---
task_id: "phase1-01"
wave: 1
depends_on: []
decisions:
  - "runbook-yaml-structure"
files:
  - skills/canon/runbooks/fast-path.yaml
principles:
  - simplicity-first
  - information-hiding
domains: []
---

## Task: Create fast-path runbook playbook

### Action

Create `skills/canon/runbooks/fast-path.yaml` -- the simplest runbook, covering the single-agent fast-path flow.

1. Create directory `skills/canon/runbooks/` if it does not exist.
2. Write the runbook file following this structure:

```yaml
name: fast-path
description: "Single-agent fast path -- implement, test, self-review in one pass"
tier: small

steps:
  - id: execute
    agent: canon-implementor
    dispatch: subagent
    mcp_tools:
      - get_principles
      - get_file_context
    artifacts:
      - "${WORKSPACE}/plans/${slug}/SUMMARY.md"
    hitl: none
    notes: >
      Spawn a single canon-implementor subagent with the task description,
      matched principles, and file context. The implementor handles implementation,
      testing, and self-review in one pass. Include commit provenance trailers
      in the spawn prompt.

  - id: pre-launch-check
    agent: null
    dispatch: subagent
    mcp_tools: []
    artifacts: []
    hitl: on_failure
    notes: >
      Run all discovered quality gates (test commands, lint commands, build commands)
      via Bash. If all pass, proceed to ship. If any fail, present the failure to
      the user for resolution.

  - id: ship
    agent: canon-shipper
    dispatch: subagent
    mcp_tools: []
    artifacts:
      - "${WORKSPACE}/plans/${slug}/PR-DESCRIPTION.md"
    hitl: none
    notes: >
      Spawn canon-shipper to synthesize build artifacts into a PR description.
      The shipper reads SUMMARY.md, git log, and any test/review reports.

  - id: learn
    agent: canon-learner
    dispatch: subagent
    mcp_tools: []
    artifacts: []
    hitl: none
    skip_when: "Learn gate not passed -- check learn gate evaluation before spawning"
    notes: >
      Evaluate the learn gate. If it passes, spawn canon-learner to analyze
      flow execution and propose principle updates. If it does not pass, skip.
```

**Key guidance**: The fast-path runbook is the reference example for all other runbooks. It demonstrates the YAML structure that all 10 runbooks follow. Keep it minimal -- fast-path has no research, no design, no wave tasks.

**Verify the flow coverage**: Compare against `flows/fast-path.md`. The legacy flow has states: `execute`, `pre-launch-check` (from fragment), `ship` (from fragment), `learn` (from fragment), `done` (terminal). The runbook covers all non-terminal states.

### Canon principles to apply

- **simplicity-first**: The runbook is a flat list of steps. No nesting, no conditionals, no branching. Claude adapts via judgment, not YAML structure.
- **information-hiding**: Each step encapsulates what the lead needs to know -- which agent, which MCP tools, what artifacts to expect. The lead does not need to know about legacy state transitions.

### Tests to write

No tests -- this is a YAML playbook file with no runtime behavior.

### Verify

1. File exists at `skills/canon/runbooks/fast-path.yaml`
2. YAML parses without errors: `python3 -c "import yaml; yaml.safe_load(open('skills/canon/runbooks/fast-path.yaml'))"`
3. Step IDs match legacy flow states: execute, pre-launch-check, ship, learn
4. `npm run build` still passes (no TypeScript changes)
5. `npm test` still passes (no test changes)

### Done when

- `skills/canon/runbooks/fast-path.yaml` exists and is valid YAML
- All four steps from the legacy fast-path flow are represented
- The file follows the runbook YAML structure defined in the design document
