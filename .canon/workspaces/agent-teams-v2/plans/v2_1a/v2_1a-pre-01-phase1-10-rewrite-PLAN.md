---
task_id: "v2_1a-pre-01"
wave: 0
depends_on: ["v2_1a-pre"]
files:
  - .canon/workspaces/agent-teams-v2/plans/phase1/phase1-10-PLAN.md
principles:
  - agent-surface-assumptions
  - agent-evidence-over-intuition
domains:
  - infrastructure
---

## Task: Rewrite phase1-10-PLAN.md against v2.1 section 10.5 criteria

### Action

`phase1-10-PLAN.md` still validates the abandoned static-runbook model. Rewrite it to validate the v2.1 deliverables that actually shipped in Phase 1.

**What to remove (stale checks):**

1. **Check 1 "Runbook coverage"** — references `skills/canon/runbooks/*.md` which do not exist and will never exist (replaced by vocabulary-based synthesis)
2. **Check 2 "Runbook format conformance"** — references `templates/runbook-template.md` which does not exist
3. **Check 3 "Skill registration completeness"** — uses the old single `skills:` field model; should validate the four-field model (rules, references, primers, templates)
4. **Check 6 "CLAUDE.md orchestration section"** — line 72 says "References all 5 runbooks by path"; should check for Agent Teams Orchestration section content instead
5. **Check 9 "Domain skills"** — references `skills:` frontmatter; should check that domain primers are NOT in any agent's preload fields (they're on-demand)

**What to add (v2.1-aligned checks):**

1. **Four-field preload validation** — for each agent, verify rules:/references:/primers:/templates: frontmatter entries resolve to actual files
2. **resolve_agent_skills tool validation** — tool exists, is registered behind CANON_AGENT_TEAMS_MODE=on, handles all four fields
3. **Agent roster validation** — 11 agents with correct model, permissionMode, maxTurns, memory settings per agents/.claude/CLAUDE.md roster
4. **CLAUDE.md Agent Teams section** — check for Skill Preloading paragraph, four-field convention, MCP Tool Composition table, Intent Classification table
5. **Template existence** — templates referenced in agents' `templates:` fields exist (e.g., planning-brief, implementation-log)

**What to keep (still valid):**

- Check 4 "Agent definition consistency" (partially — update to check four-field model instead of `skills:`)
- Check 5 "Agent roster changes" (partially — engineer/planner existence, deleted agents confirmed)
- Check 7 "Journal tool" (still valid)
- Check 8 "Hooks" (still valid — 5 hooks)
- Check 10 "Legacy path regression" (still valid)

### Canon principles to apply

- **agent-surface-assumptions** — the rewritten checks must validate what v2.1 actually shipped, not what earlier drafts envisioned
- **agent-evidence-over-intuition** — each check must be concrete and automatable

### Risk mitigations

- Without this rewrite, phase1-10 execution would fail immediately (referencing nonexistent files) or produce a misleading validation report

### Tests to write

No tests — this is a plan file amendment.

### Verify

1. Amended `phase1-10-PLAN.md` references no static runbook files
2. Amended plan validates four-field preload model
3. No check references the old single `skills:` field for Canon content
4. INDEX.md note ("REFACTORED per v2.1 section 10.5") is consistent with the amended PLAN body

### Done when

- `phase1-10-PLAN.md` rewritten with v2.1-aligned checks
- All references to static runbooks, runbook-template, and single `skills:` field removed
- Commit includes amendment note in body
