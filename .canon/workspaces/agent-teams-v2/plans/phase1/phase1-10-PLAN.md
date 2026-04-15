---
task_id: "phase1-10"
wave: 4
depends_on:
  - "phase1-08"
  - "phase1-09"
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

**1. Runbook coverage (5 checks)**:
For each runbook in `skills/canon/runbooks/*.md` (fast-path, feature, epic, migrate, test-gap):
- Parse the runbook YAML
- Read the corresponding legacy flow at `flows/{name}.md`
- Read all fragments included by the flow (e.g., `review-fix-loop`, `verify-fix-loop`, `pre-launch-check`, `ship-done`, etc.)
- Expand fragment states into the full state list
- Compare: every non-terminal state in the expanded flow must have a corresponding step in the runbook
- Report any missing states

**2. Runbook format conformance (5 checks)**:
For each runbook, validate against `skills/canon/runbooks/_template.md`:
- All required fields present (name, description, tier, steps)
- Each step has: id, agent, dispatch, mcp_tools, artifacts, hitl, notes
- `dispatch` is one of: `subagent`, `team`
- `hitl` is one of: `none`, `approval`, `checkpoint`, `on_failure`
- YAML parses without errors

**3. Skill registration completeness (1 check)**:
For each agent definition's `skills:` frontmatter list:
- Verify the named skill exists as a file under `skills/canon/references/` (either directly or via symlink from `rules/`)
- Report any unresolvable skill names

**4. Agent definition consistency (11 checks)**:
For each of the 11 agent definitions:
- YAML frontmatter parses correctly
- Has `maxTurns` (number), `permissionMode` (valid enum), `skills` (list)
- Has `memory` field where expected (planner, engineer, researcher, architect, scribe, learner = project; others = absent)
- `agent-context-check` is in every agent's skills list
- No runtime `Read ${CLAUDE_PLUGIN_ROOT}/rules/` instructions remain in body

**5. Agent roster changes (1 check)**:
- `agents/canon-engineer.md` exists with union tool list from both former agents
- `agents/canon-planner.md` exists with opus model and plan permissionMode
- `agents/canon-implementor.md` does not exist
- `agents/canon-fixer.md` does not exist
- `agents/canon-guide.md` does not exist
- `agents/canon-chat.md` does not exist
- `agents/.claude/CLAUDE.md` roster shows 11 agents
- `templates/planning-brief.md` exists
- Guide-dashboards content present in CLAUDE.md orchestration section

**6. CLAUDE.md orchestration section (1 check)**:
- Section `## Agent Teams Orchestration (CANON_AGENT_TEAMS_MODE=on)` exists
- Legacy section annotated as `(CANON_AGENT_TEAMS_MODE=off)`
- All 12 subsections present (Pre-Build Gate, Setup, MCP Tool Composition, Dispatch Framework, Journal Protocol, Post-Subagent Artifact Check, HITL Patterns, Post-Step Effects, Completion Checklist, Commit Provenance, Error Handling, flag boundary)
- Includes inline dispatch table for 4 removed flows (review, security-audit, explore, adopt)
- References all 5 runbooks by path

**7. Journal tool (1 check)**:
- `mcp-server/src/features/orchestration/tools/orchestration-journal.ts` exists
- Exports `log_step` and `verify_completion` handlers
- Registered in `register-orchestration.ts` behind feature flag
- `npm run build` passes
- `npm test` passes (including journal tests)

**8. Hooks (1 check)**:
- All 5 scripts exist and are executable: `post-commit-trailers.sh`, `completion-verify.sh`, `session-start-doc-check.sh`, `session-start-kg-check.sh`, `post-engineer-scribe.sh`
- `hooks/canon-agent-teams/hooks.json` registers all 5 hooks with correct event types
- KG-check hook correctly detects: missing DB, stale DB (computed_at_commit ≠ HEAD), fresh DB

**9. Domain skills (1 check)**:
- 12 domain skill files exist under `skills/canon/references/`: backend-api, backend-data, frontend, testing, infrastructure, deprecation, authentication-security, migration-strategy, observability, error-handling, performance, devops-ci
- Domain skills are NOT in any agent's `skills:` frontmatter (they're on-demand, loaded by the lead)
- `domain-primers/` originals migrated (files present in new location)
- CLAUDE.md orchestration section documents which domain skills to load for each task type

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
