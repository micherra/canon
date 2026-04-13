## Plan Index: Phase 1 -- Orchestration Guidance for Agent Teams Migration

| Task | Wave | Depends on | Files | Description |
|------|------|------------|-------|-------------|
| phase1-00 | 1 | -- | skills/canon/runbooks/_schema.yaml | Define canonical runbook YAML schema (commented example) |
| phase1-01 | 1 | phase1-00 | skills/canon/runbooks/fast-path.yaml | Create fast-path runbook playbook |
| phase1-02 | 1 | -- | skills/canon/runbooks/review-only.yaml, skills/canon/runbooks/security-audit.yaml, skills/canon/runbooks/explore.yaml | Create simple runbooks (review-only, security-audit, explore) |
| phase1-03 | 1 | -- | skills/canon/runbooks/test-gap.yaml, skills/canon/runbooks/adopt.yaml | Create test-gap and adopt runbooks |
| phase1-04 | 1 | -- | skills/canon/runbooks/feature.yaml, skills/canon/runbooks/refactor.yaml | Create feature and refactor runbooks (medium-tier with wave steps) |
| phase1-05 | 1 | -- | skills/canon/runbooks/epic.yaml | Create epic runbook (large-tier with multi-wave, consultations) |
| phase1-06 | 1 | -- | skills/canon/runbooks/migrate.yaml | Create migrate runbook (medium-tier with rollback emphasis) |
| phase1-07 | 2 | phase1-01 through phase1-06 | agents/*.md (all 13), skills/canon/ (rule/ref skill registrations) | Update agent definitions: maxTurns, permissionMode, skills preloading (role-specific rules + references) |
| phase1-08 | 2 | phase1-01 through phase1-06 | CLAUDE.md | Update CLAUDE.md with agent-teams orchestration section |
| phase1-09 | 3 | phase1-07, phase1-08 | All Phase 1 files | Cross-artifact validation and consistency check |

### Wave Summary

**Wave 1** (7 tasks): Define runbook YAML schema first (phase1-00), then create all 10 runbook YAML files in parallel (phase1-01 through phase1-06). All runbook tasks depend on the schema definition to prevent drift across parallel implementors.

**Wave 2** (2 tasks, parallelizable): Update agent definitions and CLAUDE.md. Depends on Wave 1 because the CLAUDE.md section references runbooks by path, and agent definition updates should be informed by what the runbooks expect of each agent type.

**Wave 3** (1 task): Cross-artifact validation. Depends on Wave 2 because it checks consistency across all artifacts.

### File Inventory

**New files (12+):**
- `skills/canon/runbooks/_schema.yaml` (canonical schema definition)
- `skills/canon/runbooks/fast-path.yaml`
- `skills/canon/runbooks/feature.yaml`
- `skills/canon/runbooks/refactor.yaml`
- `skills/canon/runbooks/epic.yaml`
- `skills/canon/runbooks/migrate.yaml`
- `skills/canon/runbooks/test-gap.yaml`
- `skills/canon/runbooks/review-only.yaml`
- `skills/canon/runbooks/security-audit.yaml`
- `skills/canon/runbooks/explore.yaml`
- `skills/canon/runbooks/adopt.yaml`
- `.canon/workspaces/agent-teams-v2/plans/phase1/VALIDATION-REPORT.md` (output of validation task)

**Modified files (14):**
- `CLAUDE.md` -- Add agent-teams orchestration section, annotate legacy section
- `agents/canon-researcher.md` -- Add maxTurns, permissionMode
- `agents/canon-architect.md` -- Add maxTurns, permissionMode
- `agents/canon-implementor.md` -- Add maxTurns, permissionMode
- `agents/canon-reviewer.md` -- Add maxTurns, permissionMode
- `agents/canon-tester.md` -- Add maxTurns, permissionMode
- `agents/canon-security.md` -- Add maxTurns, permissionMode
- `agents/canon-fixer.md` -- Add maxTurns, permissionMode
- `agents/canon-scribe.md` -- Add maxTurns, permissionMode
- `agents/canon-shipper.md` -- Add maxTurns, permissionMode
- `agents/canon-learner.md` -- Add maxTurns, permissionMode
- `agents/canon-chat.md` -- Add maxTurns, permissionMode
- `agents/canon-guide.md` -- Add maxTurns, permissionMode
- `agents/canon-writer.md` -- Add maxTurns, permissionMode

**Deleted files:** None (Phase 1 is additions-only)

**TypeScript files modified:** None
