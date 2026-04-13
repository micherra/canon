---
task_id: "phase1-08"
wave: 2
depends_on:
  - "phase1-01"
  - "phase1-02"
  - "phase1-03"
  - "phase1-04"
  - "phase1-05"
  - "phase1-06"
files:
  - CLAUDE.md
principles:
  - simplicity-first
  - information-hiding
  - externalize-configuration
domains: []
---

## Task: Update CLAUDE.md with agent-teams orchestration section

### Action

Add an "Agent Teams Orchestration" section to CLAUDE.md that provides the orchestration discipline for when `CANON_AGENT_TEAMS_MODE=on`. This section is the primary guidance document the lead reads to orchestrate Canon flows natively.

**Placement**: Add the new section AFTER the existing "Driving the State Machine" section and BEFORE "Specialist Agents". Annotate the existing section with "(Legacy)" to clarify which section applies when.

**Changes to make:**

1. **Rename the existing heading** from `## Driving the State Machine` to `## Driving the State Machine (CANON_AGENT_TEAMS_MODE=off)`. Add a one-line note: "This section applies when `CANON_AGENT_TEAMS_MODE` is unset or set to `off`. See the next section for agent-teams mode."

2. **Add new section** `## Agent Teams Orchestration (CANON_AGENT_TEAMS_MODE=on)` with the following subsections:

```markdown
## Agent Teams Orchestration (CANON_AGENT_TEAMS_MODE=on)

This section applies when `CANON_AGENT_TEAMS_MODE=on`. When off or unset, use the legacy "Driving the State Machine" section above.

### Setup

1. `init_workspace({ flow_name, task, branch, base_commit, tier, original_input, preflight: true })` -- Create or resume workspace. Check `preflight_issues` before proceeding.
2. Read the runbook for the selected flow: `skills/canon/runbooks/{flow-name}.yaml`. This is your step-by-step playbook.

### MCP Tool Composition

Before spawning each agent, compose context by calling Canon MCP tools directly:

| Tool | When to call | What it provides |
|------|-------------|-----------------|
| `get_principles` | Before every agent spawn | Matched principles for the target files/task |
| `get_file_context` | Before implementation and review steps | File summaries, dependencies, graph metrics |
| `get_drift_report` | Before review steps | Recent drift, compliance trends |
| `graph_query` | During research and design | Callers, callees, blast radius |
| `semantic_search` | During research | Conceptual code search |
| `codebase_graph` | For full graph operations | Generate or query the knowledge graph |

Include the MCP tool outputs in the agent's spawn prompt. Agents also have direct Canon MCP access (listed in their `tools` field) and can call these tools themselves.

### Dispatch Framework

| Step pattern | Dispatch | Example |
|-------------|----------|---------|
| Single agent, focused task | Subagent | Research, review, security scan |
| Sequential pipeline | Chained subagents | Research -> design -> implement -> review |
| Parallel implementation (wave) | Agent team | Multiple implementors on independent tasks |
| Advisory opinion | Subagent | Consultation (pattern-check, targeted-research) |

**Subagent dispatch**: Spawn with the agent definition type (e.g., `canon-researcher`). Include isolation: worktree for implementation agents. Include the runbook step's `mcp_tools` outputs in the spawn prompt.

**Agent team dispatch**: For wave steps (implementation across multiple files):
1. Create git worktrees: `git worktree add .canon/worktrees/{task-id} -b canon-wave/{task-id}`
2. Create the agent team with one teammate per task from the plan index
3. Each teammate gets its task plan file as instructions
4. Teammates coordinate via shared task list (dependencies auto-unblock)
5. After all tasks complete, merge worktrees: `git merge canon-wave/{task-id}`
6. Clean up worktrees: `git worktree remove .canon/worktrees/{task-id}`

### HITL Patterns

Handle human-in-the-loop natively:
- **Plan approval**: Present the architect's design to the user. Ask for approval, revision requests, or rejection. Loop back to design on revisions. Max 3 rounds.
- **On failure**: When a gate fails, a review is BLOCKING, or an agent reports BLOCKED, present the details to the user and ask how to proceed.
- **Merge conflicts**: If worktree merges produce conflicts, present the conflicts to the user for resolution.
- **Wave checkpoints**: At the end of each epic wave, summarize progress and present to the user.

### Post-Step Effects

After certain steps, the lead runs effects:
- **After review**: Call `store_pr_review` MCP tool to persist the review (persist_review effect).
- **After implementation**: Run contract-checker assertions if the flow defines postconditions (check_postconditions effect). Use Bash to run the shell commands.
- **After any step**: Call `record_agent_metrics` to record the agent's performance metrics.

### Commit Provenance

Instruct agents to include Canon trailers in all commits:
```
Canon-Workflow: {workflow-slug}
Canon-Agent: {agent-type}
Canon-State: {step-id}
Canon-Task: {task-id}
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```
Include the trailer values in each agent's spawn prompt under a `## Commit Provenance` heading.

### Completion Checklist

After the final step (ship or learn):
1. Call `update_board({ operation: "complete_flow" })` -- aggregates metrics, releases file claims.
2. Verify all expected artifacts exist in the workspace.
3. Evaluate the learn gate: run `.canon/learn.sh` via Bash if it exists.
4. Present a completion summary naming the notable artifacts from each step.

### Runbook Reference

Runbooks live at `skills/canon/runbooks/{flow-name}.yaml`. Each runbook lists:
- `steps[].id` -- Step identifier
- `steps[].agent` -- Which agent to spawn (null for gate-only steps)
- `steps[].dispatch` -- `subagent` or `team`
- `steps[].mcp_tools` -- MCP tools to call before this step
- `steps[].artifacts` -- Expected output files
- `steps[].hitl` -- Whether this step has a user checkpoint
- `steps[].skip_when` -- Optional skip condition
- `steps[].notes` -- Detailed guidance for this step

Follow the runbook's step sequence. Adapt when the situation warrants -- the runbook is guidance, not a rigid script.
```

3. **Do NOT modify** any other section of CLAUDE.md. The intent classification table, specialist agents table, agent spawn error handling, project structure, and reference sections remain unchanged.

### Canon principles to apply

- **simplicity-first**: The agent-teams section is a self-contained reference. No cross-references to other documents needed for basic orchestration.
- **information-hiding**: The lead does not need to understand legacy flow YAML, prompt pipelines, or state transitions. The runbook and MCP tools provide everything.
- **externalize-configuration**: The feature flag is an environment variable, documented as the switch between sections.

### Risk mitigations

- **Risk: Existing CLAUDE.md sections broken by edit** -- Mitigation: Only add new content and rename one heading. Do not rewrite existing content. Verify the full file parses correctly after edit.
- **Risk: Lead follows wrong section** -- Mitigation: Each section's heading includes the flag condition. The first line of each section states when it applies.

### Tests to write

No new tests. Verify `npm run build` and `npm test` still pass.

### Verify

1. CLAUDE.md contains both the legacy section (annotated) and the new agent-teams section
2. The agent-teams section covers all six topics: MCP tool composition, dispatch framework, HITL patterns, post-step effects, completion checklist, commit provenance
3. The legacy section heading is updated to include the flag condition
4. No other sections of CLAUDE.md are modified
5. `npm run build` and `npm test` pass

### Done when

- CLAUDE.md has the agent-teams orchestration section gated by `CANON_AGENT_TEAMS_MODE=on`
- All six subsections are present and complete
- Legacy section is annotated but functionally unchanged
- Feature flag wiring is documented (env var name, default behavior, how to enable)
