---
task_id: "phase1-12"
wave: 4
depends_on:
  - "phase1-10"
  - "phase1-11"
files:
  - .canon/workspaces/agent-teams-v2/plans/phase1/VALIDATION-REPORT.md (new)
principles:
  - explicit-contracts
domains: []
---

## Task: Cross-artifact validation

### Action

Validate consistency across all Phase 1 artifacts. Produce a `VALIDATION-REPORT.md` with pass/fail for each check.

#### Checks to perform

**1. Runbook coverage (10 checks)**:
For each runbook in `skills/canon/runbooks/*.yaml`:
- Parse the runbook YAML
- Read the corresponding legacy flow at `flows/{name}.md`
- Read all fragments included by the flow (e.g., `review-fix-loop`, `verify-fix-loop`, `pre-launch-check`, `ship-done`, etc.)
- Expand fragment states into the full state list
- Compare: every non-terminal state in the expanded flow must have a corresponding step in the runbook
- Report any missing states

**2. Runbook schema conformance (10 checks)**:
For each runbook, validate against `skills/canon/runbooks/_schema.yaml`:
- All required fields present (name, description, tier, steps)
- Each step has: id, agent, dispatch, mcp_tools, artifacts, hitl, notes
- `dispatch` is one of: `subagent`, `team`
- `hitl` is one of: `none`, `approval`, `checkpoint`, `on_failure`
- YAML parses without errors

**3. Skill registration completeness (1 check)**:
For each agent definition's `skills:` frontmatter list:
- Verify the named skill exists as a file under `skills/canon/references/` (either directly or via symlink from `rules/`)
- Report any unresolvable skill names

**4. Agent definition consistency (12 checks)**:
For each of the 12 agent definitions:
- YAML frontmatter parses correctly
- Has `maxTurns` (number), `permissionMode` (valid enum), `skills` (list)
- `agent-context-check` is in every agent's skills list
- No runtime `Read ${CLAUDE_PLUGIN_ROOT}/rules/` instructions remain in body

**5. Engineer consolidation (1 check)**:
- `agents/canon-engineer.md` exists
- `agents/canon-implementor.md` does not exist
- `agents/canon-fixer.md` does not exist
- canon-engineer's tools list is the union of both former agents' tools
- `agents/.claude/CLAUDE.md` roster shows 12 agents

**6. CLAUDE.md orchestration section (1 check)**:
- Section `## Agent Teams Orchestration (CANON_AGENT_TEAMS_MODE=on)` exists
- Legacy section annotated as `(CANON_AGENT_TEAMS_MODE=off)`
- All 11 subsections present (Setup, MCP Tool Composition, Dispatch Framework, Journal Protocol, Post-Subagent Artifact Check, HITL Patterns, Post-Step Effects, Completion Checklist, Commit Provenance, Error Handling, flag boundary)
- References all 10 runbooks by path

**7. Journal tool (1 check)**:
- `mcp-server/src/features/orchestration/tools/orchestration-journal.ts` exists
- Exports `log_step` and `verify_completion` handlers
- Registered in `register-orchestration.ts` behind feature flag
- `npm run build` passes
- `npm test` passes (including journal tests)

**8. Hooks (1 check)**:
- `hooks/canon-agent-teams/post-commit-trailers.sh` exists and is executable
- `hooks/canon-agent-teams/completion-verify.sh` exists and is executable
- `hooks/canon-agent-teams/hooks.json` registers both hooks

**9. Domain primers (1 check)**:
- `canon-engineer` skills include all 6 domain primers
- `canon-architect` skills include all 6 domain primers
- No other agent has domain primers (they don't need them)

**10. Legacy path regression (1 check)**:
- `CANON_AGENT_TEAMS_MODE` unset: `npm run build` passes, `npm test` passes
- No existing test failures introduced by Phase 1 changes
- Journal tool not registered when flag is off (verify via tool list inspection)

### Canon principles to apply

- **explicit-contracts**: Every check has a concrete pass/fail criterion.

### Tests to write

No new tests — this task runs validation checks, not code.

### Verify

1. `VALIDATION-REPORT.md` exists with results for all checks
2. All checks pass
3. If any check fails, the report documents the failure and what needs fixing

### Done when

- All checks pass
- `VALIDATION-REPORT.md` documents results
- `npm run build` and `npm test` pass with zero regressions
