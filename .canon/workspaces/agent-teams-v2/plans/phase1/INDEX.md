## Plan Index: Phase 1 — Orchestration Guidance for Agent Teams Migration

| Task | Wave | Depends on | Key files | Description |
|------|------|------------|-----------|-------------|
| phase1-00 | 1 | — | skills/canon/runbooks/_schema.yaml | Define canonical runbook YAML schema |
| phase1-01 | 1 | phase1-00 | skills/canon/runbooks/fast-path.yaml | Create fast-path runbook |
| phase1-02 | 1 | phase1-00 | skills/canon/runbooks/{review-only,security-audit,explore}.yaml | Create simple runbooks (1-3 steps) |
| phase1-03 | 1 | phase1-00 | skills/canon/runbooks/{test-gap,adopt}.yaml | Create fix-loop runbooks |
| phase1-04 | 1 | phase1-00 | skills/canon/runbooks/{feature,refactor}.yaml | Create medium-tier runbooks (wave steps) |
| phase1-05 | 1 | phase1-00 | skills/canon/runbooks/epic.yaml | Create epic runbook (multi-wave, consultations) |
| phase1-06 | 1 | phase1-00 | skills/canon/runbooks/migrate.yaml | Create migrate runbook (rollback emphasis) |
| phase1-07 | 2 | Wave 1 | rules/*.md → skills/canon/references/, rules/agent-context-check.md | Register rules as skills, create agent-context-check rule |
| phase1-08 | 2 | Wave 1 | mcp-server/src/features/orchestration/tools/orchestration-journal.ts | Orchestration journal tool (log_step + verify_completion) |
| phase1-09 | 2 | Wave 1 | hooks/canon-agent-teams/{post-commit-trailers.sh,completion-verify.sh,hooks.json} | PostCommit trailer hook + completion verification hook |
| phase1-10 | 3 | Wave 2 | agents/*.md (delete 2, create 1, modify 11) | Engineer consolidation + all agent frontmatter + skills preloading |
| phase1-11 | 3 | Wave 2 | CLAUDE.md | Agent-teams orchestration section (11 subsections) |
| phase1-12 | 4 | Wave 3 | VALIDATION-REPORT.md | Cross-artifact validation (10 check categories) |

### Wave Summary

**Wave 1** (7 tasks): Define runbook schema, then create all 10 runbook playbooks in parallel. All runbook tasks depend on the schema to prevent drift.

**Wave 2** (3 tasks, parallel): Register rules as skills, build orchestration journal tool, write enforcement hooks. No dependencies between these three — they can run in parallel.

**Wave 3** (2 tasks, parallel): Update all agent definitions (engineer consolidation + frontmatter + skills) and write CLAUDE.md orchestration section. These depend on Wave 2 because CLAUDE.md references the journal and hooks, and agent defs reference registered skills.

**Wave 4** (1 task): Cross-artifact validation. Depends on everything. Produces VALIDATION-REPORT.md.

### File Inventory

**New files (16):**
- `skills/canon/runbooks/_schema.yaml`
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
- `rules/agent-context-check.md`
- `mcp-server/src/features/orchestration/tools/orchestration-journal.ts`
- `hooks/canon-agent-teams/post-commit-trailers.sh`
- `hooks/canon-agent-teams/completion-verify.sh`
- `agents/canon-engineer.md`

**Modified files (13):**
- `CLAUDE.md` — add agent-teams orchestration section, annotate legacy section
- `agents/.claude/CLAUDE.md` — update roster (12 agents, not 13)
- `agents/canon-researcher.md` — add maxTurns, permissionMode, skills
- `agents/canon-architect.md` — add maxTurns, permissionMode, skills
- `agents/canon-reviewer.md` — add maxTurns, permissionMode, skills
- `agents/canon-tester.md` — add maxTurns, permissionMode, skills
- `agents/canon-security.md` — add maxTurns, permissionMode, skills
- `agents/canon-scribe.md` — add maxTurns, permissionMode, skills
- `agents/canon-shipper.md` — add maxTurns, permissionMode, skills
- `agents/canon-learner.md` — add maxTurns, permissionMode, skills
- `agents/canon-chat.md` — add maxTurns, permissionMode, skills
- `agents/canon-guide.md` — add maxTurns, permissionMode, skills
- `agents/canon-writer.md` — add maxTurns, permissionMode, skills

**Deleted files (2):**
- `agents/canon-implementor.md` (replaced by canon-engineer)
- `agents/canon-fixer.md` (replaced by canon-engineer)

**New TypeScript (1 file, ~50-80 lines):**
- `mcp-server/src/features/orchestration/tools/orchestration-journal.ts`

**Symlinks (~19):**
- `rules/agent-*.md` → `skills/canon/references/agent-*.md` (skill registrations)
