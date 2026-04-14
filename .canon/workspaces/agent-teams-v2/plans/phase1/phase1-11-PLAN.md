---
task_id: "phase1-11"
wave: 3
depends_on:
  - "phase1-00"
  - "phase1-01"
  - "phase1-02"
  - "phase1-03"
  - "phase1-04"
  - "phase1-05"
  - "phase1-06"
  - "phase1-08"
  - "phase1-10"
files:
  - CLAUDE.md
principles:
  - simplicity-first
  - information-hiding
  - externalize-configuration
domains: []
---

## Task: CLAUDE.md agent-teams orchestration section

### Action

Add a new section to CLAUDE.md that provides orchestration discipline when `CANON_AGENT_TEAMS_MODE=on`. This is the lead's primary guidance document for native Canon flow orchestration.

#### 1. Annotate existing section

Rename `## Driving the State Machine` to `## Driving the State Machine (CANON_AGENT_TEAMS_MODE=off)`. Add one-line note: "This section applies when CANON_AGENT_TEAMS_MODE is unset or off."

#### 2. Add new section after it

```markdown
## Agent Teams Orchestration (CANON_AGENT_TEAMS_MODE=on)

If `CANON_AGENT_TEAMS_MODE` is not set to `on`, do not follow this section — use the legacy "Driving the State Machine" section above.
```

Include these subsections:

**Setup**:
1. Call `init_workspace({ flow_name, task, branch, base_commit, tier, original_input, preflight: true })`.
2. Read the runbook for the selected flow: `skills/canon/runbooks/{flow-name}.yaml`.
3. Call `log_step` for each planned step from the runbook (creates the checklist).

**MCP Tool Composition**:
Table of which Canon MCP tools to call before spawning each step type:

| Step type | MCP tools to call |
|-----------|------------------|
| Research | `get_principles`, `get_file_context`, `graph_query`, `semantic_search` |
| Design | `get_principles`, `get_file_context`, `graph_query` |
| Implement | `get_principles`, `get_file_context`, `get_drift_report` |
| Review | `get_principles`, `get_drift_report` |
| Test | `get_principles`, `get_file_context` |
| Security | `get_principles`, `get_file_context` |

Include results in the spawn prompt. Agents also have direct MCP access and will self-serve missing context (via `agent-context-check` skill).

**Dispatch Framework**:
| Pattern | Primitive |
|---------|-----------|
| Sequential step (research, design, review) | Subagent |
| Parallel implementation (wave tasks) | Agent team |
| Debate / competing hypotheses | Agent team |
| Advisory consultation | Subagent |
| Background housekeeping | Subagent (background) |

**Journal Protocol**:
- Before each spawn: `log_step({ workspace, step_id, agent_type, artifacts_expected, status: "started" })`
- After each spawn: `log_step({ workspace, step_id, ..., status: "completed", artifacts_actual: [...] })`
- The journal is your checklist. The completion hook verifies it.

**Post-Subagent Artifact Check**:
After each subagent returns, verify expected artifacts exist at the paths listed in the runbook's `artifacts` field before proceeding to the next step. Subagents don't trigger `TaskCompleted` hooks — this manual check is your enforcement layer.

**HITL Patterns**:
- **Architect approval**: Present the plan to the user. For agent teams, use native plan approval mode.
- **Review verdict**: Present review results. If not clean, spawn engineer in fix mode.
- **Gate failure**: Present the failure output and ask the user how to proceed.
- **Merge conflict**: Present conflicting files and ask for resolution strategy.

**Post-Step Effects**:
After reviewer completes: call `store_pr_review` or `write_review`.
After each step: call `record_agent_metrics` if the agent didn't call it itself.
Run contract-checker assertions via Bash when postconditions are declared.

**Completion Checklist**:
1. Call `verify_completion({ workspace })` — if steps or artifacts missing, resolve before proceeding.
2. Call `update_board({ workspace, operation: "complete_flow" })`.
3. Verify file claims released.
4. Evaluate learn gate: run `.canon/learn.sh` if it exists.
5. Record final flow metrics.

**Commit Provenance**:
All agent commits must include trailers:
```
Canon-Workflow: {slug}
Canon-Agent: {agent-type}
Canon-State: {step-id}
Canon-Task: {task-id}  # wave tasks only
```
The PostCommit hook validates `Canon-Workflow` trailer presence.

**Error Handling**:
Cross-reference the existing "Agent Spawn Error Handling" section. The same retry logic (429 rate limits, auth failures, TTL ordering) applies to agent-teams orchestration. Retry up to 3 times with exponential backoff. If all retries fail, inform the user and pause.

### Canon principles to apply

- **simplicity-first**: One section, eleven subsections. No nested conditionals or complex decision trees.
- **information-hiding**: Each subsection is self-contained. The lead reads what it needs for the current step.
- **externalize-configuration**: Feature flag is an env var. Runbook selection is data-driven.

### Tests to write

No tests — this is CLAUDE.md content. Validation is in phase1-12.

### Verify

1. CLAUDE.md contains `## Agent Teams Orchestration (CANON_AGENT_TEAMS_MODE=on)` section
2. Existing section renamed to `## Driving the State Machine (CANON_AGENT_TEAMS_MODE=off)`
3. New section has all 11 subsections listed above
4. Explicit flag boundary statement at top of new section
5. Cross-reference to "Agent Spawn Error Handling" present
6. All 10 runbook paths referenced
7. Journal protocol documented (log_step before/after each spawn)

### Done when

- CLAUDE.md updated with agent-teams orchestration section
- Legacy section annotated
- All 11 subsections present with concrete guidance
- Flag boundary explicit
