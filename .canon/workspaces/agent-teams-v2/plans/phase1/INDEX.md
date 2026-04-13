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
| phase1-07a | 2 | phase1-01 through phase1-06 | rules/*.md → skills/canon/references/, new `rules/agent-context-check.md` | Register rules as skills: copy/symlink rule files into `skills/canon/references/` so agent `skills:` frontmatter can reference them. Create `agent-context-check` rule for self-serve context verification. |
| phase1-07b | 2 | phase1-07a | agents/*.md (12 — merge implementor+fixer → engineer) | Update agent definitions: consolidate to `canon-engineer`, add maxTurns, permissionMode, skills preloading, domain primer preloading |
| phase1-08 | 2 | phase1-01 through phase1-06 | CLAUDE.md | Update CLAUDE.md with agent-teams orchestration section. Include post-subagent artifact check, cross-reference existing error handling, explicit flag boundary statement. |
| phase1-09 | 3 | phase1-07b, phase1-08 | All Phase 1 files | Cross-artifact validation: runbook-to-flow coverage (including fragment expansion), agent def consistency, skill registration completeness, YAML validity, build/test pass |

### Wave Summary

**Wave 1** (7 tasks): Define runbook YAML schema first (phase1-00), then create all 10 runbook YAML files in parallel (phase1-01 through phase1-06). All runbook tasks depend on the schema definition to prevent drift across parallel implementors.

**Wave 2** (3 tasks): Register rules as skills (phase1-07a), then update agent definitions including engineer consolidation (phase1-07b, depends on 07a), plus CLAUDE.md update (phase1-08, parallel with 07a/07b). Agent def updates depend on Wave 1 runbooks.

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
