---
task_id: "phase1-09"
wave: 3
depends_on:
  - "phase1-05"
  - "phase1-06"
  - "phase1-07"
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

**Intent Classification + Runbook Selection**:
Reproduce the flow selection table from the existing CLAUDE.md, mapped to the new model:

| Signal | Action |
|--------|--------|
| Bug fix, small change, 1–3 files | Read `fast-path.md` runbook |
| New feature, 4–10 files | Read `feature.md` runbook (variant: refactor if restructuring) |
| Large cross-cutting, 10+ files | Read `epic.md` runbook |
| Migration, upgrade, "move to X" | Read `migrate.md` runbook |
| Improve test coverage | Read `test-gap.md` runbook |
| Review PR or branch | Spawn `canon-reviewer` (no runbook) |
| Security audit | Spawn `canon-security`, then `canon-reviewer` (no runbook) |
| Investigate / "how does X work" | Spawn `canon-researcher`(s), synthesize (no runbook) |
| Scan for violations (via init) | Spawn `canon-engineer` to scan + fix (no runbook) |
| Create/edit principle | Spawn `canon-writer` (no runbook) |
| Analyze patterns / learn | Spawn `canon-learner` (no runbook) |
| Resume interrupted flow | See Resume Protocol below |
| Vague / unclear request | Spawn `canon-planner` (pre-build gate) |

**Pre-Build Gate**:
Before starting any build flow, evaluate the request:
- Is the problem clearly defined? Are acceptance criteria explicit?
- Have alternatives been considered? Is the value proportional to the effort?
- If any answer is no, spawn `canon-planner` before proceeding to a build runbook.
- If the request is a clear bug fix or small change with obvious scope, skip to fast-path.

**Setup**:
1. Call `init_workspace({ flow_name, task, branch, base_commit, tier, original_input, preflight: true })`.
2. Read the runbook for the selected flow: `skills/canon/runbooks/{flow-name}.md`.
3. Call `log_step` for each planned step from the runbook (creates the checklist).

**Resume Protocol**:
When resuming a session or the user says "continue" / "resume":
1. Read the journal file (`journal.json` in the workspace).
2. Identify the last step with `status: "completed"`.
3. Read the workspace artifacts produced by completed steps for context.
4. Continue from the first step with `status: "started"` or the next unstarted step.
5. If no journal exists, check for legacy workspace state and advise the user.

**Domain Skill + Template Naming**:
Before spawning an agent, name relevant domain skills and the output template in the spawn prompt:
- Domain skills: `"Relevant domain skills: authentication-security, backend-api. Load from skills/canon/references/."`
- Template: `"Use template: implementation-log. Read from templates/implementation-log.md."`
- Do NOT read and inject file content yourself — the agent reads the named files on its first turn (per `agent-context-check`).
- This keeps the lead's context clean and puts the Read cost in the agent's fresh context.
- Same pattern for both: lead names, agent loads.

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

- **simplicity-first**: One section, fourteen subsections. No nested conditionals or complex decision trees.
- **information-hiding**: Each subsection is self-contained. The lead reads what it needs for the current step.
- **externalize-configuration**: Feature flag is an env var. Runbook selection is data-driven.

### Tests to write

No tests — this is CLAUDE.md content. Validation is in phase1-10.

### Verify

1. CLAUDE.md contains `## Agent Teams Orchestration (CANON_AGENT_TEAMS_MODE=on)` section
2. Existing section renamed to `## Driving the State Machine (CANON_AGENT_TEAMS_MODE=off)`
3. New section has all subsections: Intent Classification + Runbook Selection, Pre-Build Gate, Setup, Resume Protocol, Domain Skill Loading, MCP Tool Composition, Dispatch Framework, Journal Protocol, Post-Subagent Artifact Check, HITL Patterns, Post-Step Effects, Completion Checklist, Commit Provenance, Error Handling
4. Explicit flag boundary statement at top of new section
5. Cross-reference to "Agent Spawn Error Handling" present
6. Intent table covers all intents: 5 runbook flows + 6 inline dispatches (review, security, explore, adopt, principle, learn) + resume + vague
7. All 5 runbook paths referenced
8. Journal protocol documented (log_step before/after each spawn)
9. Resume protocol documented (read journal, identify last step, continue)
10. Domain skill loading documented (name skills, agent reads them)

### Done when

- CLAUDE.md updated with agent-teams orchestration section
- Legacy section annotated
- All 14 subsections present with concrete guidance
- Flag boundary explicit
