## Plan Index: Phase 1 — Orchestration Guidance for Agent Teams Migration

> **⚠️ SUPERSEDED BY v2.1:** tasks phase1-00 through phase1-04 are **ABANDONED** per the v2.1 plan (`docs/agent-teams-migration-plan-v2.1.md`). The static-runbook-files approach has been replaced by vocabulary-based synthesis (canon-planner emits runbooks from a canonical step vocabulary). phase1-05..09 remain REQUIRED v2 Phase 1 deliverables — v2.1 builds on top of them. phase1-10 (validation) is REFACTORED per v2.1 — see v2.1 §10.5. phase1-00's landed artifacts (`templates/runbook-template.md` + `skills/canon/runbooks/README.md`) were DELETED in PR #115 in favor of the synthesis skill (`skills/canon/references/runbook-synthesis.md`, v2.1a Wave 1 deliverable).

| Task | Wave | Depends on | Key files | Description | v2.1 status |
|------|------|------------|-----------|-------------|-------------|
| phase1-00 | 1 | — | (deleted) | ~~Define runbook format (markdown + YAML frontmatter)~~ | **ABANDONED**; runbook format defined by v2.1a synthesis skill |
| phase1-01 | 1 | phase1-00 | ~~skills/canon/runbooks/fast-path.md~~ | ~~Create fast-path runbook~~ | **ABANDONED**; no static runbook files in v2.1 |
| phase1-02 | 1 | phase1-00 | ~~skills/canon/runbooks/feature.md~~ | ~~Create feature runbook~~ | **ABANDONED** |
| phase1-03 | 1 | phase1-00 | ~~skills/canon/runbooks/{epic.md,migrate.md}~~ | ~~Create epic + migrate runbooks~~ | **ABANDONED** |
| phase1-04 | 1 | phase1-00 | ~~skills/canon/runbooks/test-gap.md~~ | ~~Create test-gap runbook~~ | **ABANDONED** |
| phase1-05 | 2 | Wave 1 | rules/*.md → skills/canon/references/, domain-primers/*.md → skills/canon/references/, 6 new domain skills, rules/agent-context-check.md | Register rules as skills, migrate domain primers, create 6 new domain skills, create agent-context-check rule | **REQUIRED** (v2 Phase 1; v2.1 builds on this) |
| phase1-06 | 2 | Wave 1 | mcp-server/src/features/orchestration/tools/orchestration-journal.ts | Orchestration journal tool (log_step + verify_completion) | **REQUIRED** |
| phase1-07 | 2 | Wave 1 | hooks/canon-agent-teams/*.sh, hooks/canon-agent-teams/hooks.json | All hooks: PostCommit trailers, completion verify, SessionStart doc-check, SessionStart KG-check, SubagentStop scribe-queue | **REQUIRED** (v2.1a adds one more hook: `canon-workspace-check.sh` / L4) |
| phase1-08 | 3 | Wave 2 | agents/*.md (delete 4, create 2, modify 9) | Delete implementor+fixer+guide+chat, add engineer+planner (11 agents) | **REQUIRED — GATE A for v2.1** (creates canon-planner + canon-engineer) |
| phase1-09 | 3 | Wave 2 | CLAUDE.md | Agent-teams orchestration section | **REQUIRED**; v2.1a will amend further (L1 re-classification discipline) |
| phase1-10 | 4 | Wave 3 | VALIDATION-REPORT.md | Cross-artifact validation | **REFACTORED** per v2.1 §10.5 (validates vocabulary + synthesis behavior, not 5 static runbook files) |

### Wave Summary

**Wave 1** (5 tasks): Define runbook format, then create all 5 runbook playbooks in parallel. Each runbook includes context-sync (scribe) and learn (learner) as final steps.

**Wave 2** (3 tasks, parallel): Register rules as skills, build orchestration journal tool, write all enforcement hooks (5 scripts). No dependencies between these three.

**Wave 3** (2 tasks, parallel): Update all agent definitions (engineer consolidation + frontmatter + skills) and write CLAUDE.md orchestration section. CLAUDE.md includes inline dispatch for simple intents (review, security-audit, explore, adopt) that don't need runbooks.

**Wave 4** (1 task): Cross-artifact validation.

### Scribe and Learner Automation

Every build runbook (fast-path, feature, epic, migrate) includes:
- `context-sync` step: spawn canon-scribe to update documentation. Scribe writes HEAD commit to `.canon/last-scribe-commit` after running.
- `learn` step: evaluate learn gate (`.canon/learn.sh`), spawn canon-learner as background subagent if gate passes. Learner has `memory: project` for cross-session persistence.

Additional automation hooks:
- **SessionStart**: `session-start-doc-check.sh` compares HEAD against `.canon/last-scribe-commit`. Nudges lead if docs may be stale.
- **SubagentStop**: `post-engineer-scribe.sh` writes `pending-scribe.json` after canon-engineer completes. Lead runs scribe before completing the flow.
- **Completion verify**: `completion-verify.sh` checks that context-sync and learn steps were completed (via journal).

### Removed Flows (handled via CLAUDE.md dispatch)

These legacy flows are NOT converted to runbooks. CLAUDE.md's dispatch section handles them as inline guidance:

| Intent | CLAUDE.md dispatch action |
|--------|--------------------------|
| review | Spawn canon-reviewer with target PR/branch. Single subagent, no runbook. |
| security audit | Spawn canon-security, then canon-reviewer. Two subagents sequentially. |
| explore | Spawn canon-researcher(s), synthesize findings via canon-architect. |
| adopt (via init) | Scan for violations, spawn canon-engineer to fix, rescan. |

### File Inventory

**New files (15):**
- `templates/runbook-template.md`
- `skills/canon/runbooks/README.md`
- `skills/canon/runbooks/fast-path.md`
- `skills/canon/runbooks/feature.md`
- `skills/canon/runbooks/epic.md`
- `skills/canon/runbooks/migrate.md`
- `skills/canon/runbooks/test-gap.md`
- `rules/agent-context-check.md`
- `mcp-server/src/features/orchestration/tools/orchestration-journal.ts`
- `hooks/canon-agent-teams/post-commit-trailers.sh`
- `hooks/canon-agent-teams/completion-verify.sh`
- `hooks/canon-agent-teams/session-start-doc-check.sh`
- `hooks/canon-agent-teams/session-start-kg-check.sh`
- `hooks/canon-agent-teams/post-engineer-scribe.sh`
- `agents/canon-engineer.md`
- `agents/canon-planner.md`

**Modified files (11):**
- `CLAUDE.md` — add agent-teams orchestration section (including guide-dashboards content), annotate legacy section
- `agents/.claude/CLAUDE.md` — update roster (11 agents)
- `hooks/canon-agent-teams/hooks.json` — register 5 new hook scripts
- 9 × `agents/canon-*.md` — add maxTurns, permissionMode, memory, skills

**Deleted files (4):**
- `agents/canon-implementor.md` (replaced by canon-engineer)
- `agents/canon-fixer.md` (replaced by canon-engineer)
- `agents/canon-guide.md` (lead handles via MCP tools directly)
- `agents/canon-chat.md` (lead handles natively; planner covers structured evaluation)

**New TypeScript (1 file, ~50-80 lines):**
- `mcp-server/src/features/orchestration/tools/orchestration-journal.ts`

**Symlinks (~19):**
- `rules/agent-*.md` → `skills/canon/references/agent-*.md` (skill registrations)
