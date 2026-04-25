## Plan Index: Phase 1 — Orchestration Guidance for Agent Teams Migration

> **v2.1 alignment.** Phase 1 feeds into the v2.1a + v2.1b task trees at `.canon/workspaces/agent-teams-v2/plans/v2_1a/` and `.../v2_1b/`. Gate A (`planner` + `engineer` exist and validate in ≥ 3 runs) is produced by `phase1-08`; it is the hard precondition for any v2.1a work. See `docs/agent-teams-migration-plan-v2.md` §§10.1, 15.1.
>
> **Consolidated, one source of truth.** The 5 static-runbook authoring tasks that v1 / pre-v2.1 drafts envisioned (phase1-00..04) have been deleted — v2.1 replaces them with vocabulary-based synthesis (see v2_1a-00..02). Only the REQUIRED Phase 1 tasks remain below.

| Task | Wave | Depends on | Key files | Description |
|------|------|------------|-----------|-------------|
| phase1-05 | 1 | — | `rules/*.md` → `references/`, `domain-primers/*.md` → `references/`, 6 new domain skills, `rules/agent-context-check.md` | Register rules as skills, migrate domain primers, create 6 new domain skills, create agent-context-check rule |
| phase1-06 | 1 | — | `mcp-server/src/features/orchestration/tools/orchestration-journal.ts` | Orchestration journal tool (`log_step` + `verify_completion`; v2.1 extends with `domain_skills_loaded` + `outcome` fields — see v2.md §2.9) |
| phase1-07 | 1 | — | `hooks/canon-agent-teams/*.sh`, `hooks/canon-agent-teams/hooks.json` | 5 hooks: PostCommit trailers, completion verify, SessionStart doc-check, SessionStart KG-check, SubagentStop scribe-queue. v2.1a adds a 6th hook (`canon-workspace-check.sh` / L4) via v2_1a-05. |
| phase1-08 | 2 | Wave 1 | `agents/*.md` (delete 4, create 2, modify 9) | Delete implementor+fixer+guide+chat, add engineer+planner (11 agents). **GATE A for v2.1** — produces `planner` + `engineer` that v2.1a depends on. |
| phase1-09 | 2 | Wave 1 | `CLAUDE.md` | Agent-teams orchestration section. v2.1a amends further with L1 per-message intent re-classification (v2_1a-04). |
| phase1-10 | 3 | Wave 2 | `VALIDATION-REPORT.md` | Cross-artifact validation. **REFACTORED per v2.1 §10.5** — validates planner + engineer + skills preloading + MCP tool registration; does NOT validate static runbook files (abandoned). Before running, confirm scope in `v2_1a-pre` preflight. |

### Wave Summary

**Wave 1** (3 tasks, parallel): phase1-05 skills registration, phase1-06 orchestration journal tool, phase1-07 hooks. No dependencies between these three.

**Wave 2** (2 tasks, parallel): phase1-08 agent roster consolidation (Gate A), phase1-09 CLAUDE.md orchestration section.

**Wave 3** (1 task): phase1-10 cross-artifact validation (refactored scope per v2.1 §10.5).

### Exit criteria (Gate A)

Per `docs/agent-teams-migration-plan-v2.md` §10.1:

- `planner` and `engineer` agent definitions exist and register with the Canon MCP server
- Both validated in ≥ 3 successful runs under `CANON_AGENT_TEAMS_MODE=on`
- CLAUDE.md has orchestration section matching v2.md §2
- All 5 Phase 1 hook scripts exist, are executable, register in `hooks/canon-agent-teams/hooks.json`
- Skill preloading validated for at least 3 agent types
- `npm run build` and `npm test` pass

When Gate A passes, v2.1a Wave 0 (preflight) may begin.

### Removed Flows (handled via CLAUDE.md dispatch)

These legacy flows are NOT converted to runbooks. CLAUDE.md's dispatch section handles them as inline guidance:

| Intent | CLAUDE.md dispatch action |
|--------|--------------------------|
| review | Spawn reviewer with target PR/branch. Single subagent, no runbook. |
| security audit | Spawn security, then reviewer. Two subagents sequentially. |
| explore | Spawn researcher(s), synthesize findings via architect. |
| adopt (via init) | Scan for violations, spawn engineer to fix, rescan. |

### File Inventory

**New files (10, reduced from 15 per v2.1 synthesis replacement):**

- `rules/agent-context-check.md`
- `mcp-server/src/features/orchestration/tools/orchestration-journal.ts`
- `hooks/canon-agent-teams/post-commit-trailers.sh`
- `hooks/canon-agent-teams/completion-verify.sh`
- `hooks/canon-agent-teams/session-start-doc-check.sh`
- `hooks/canon-agent-teams/session-start-kg-check.sh`
- `hooks/canon-agent-teams/post-engineer-scribe.sh`
- `agents/engineer.md`
- `agents/planner.md`
- 6 new domain skill files under `references/`

The static runbook files that earlier drafts specified (`templates/runbook-template.md`, `skills/canon/runbooks/README.md` + 5 runbooks) are NOT produced — superseded by v2.1a's vocabulary-based synthesis.

**Modified files (11):**

- `CLAUDE.md` — add agent-teams orchestration section (including guide-dashboards content), annotate legacy section
- `agents/.claude/CLAUDE.md` — update roster (11 agents)
- `hooks/canon-agent-teams/hooks.json` — register 5 new hook scripts
- 9 × `agents/canon-*.md` — add maxTurns, permissionMode, memory, skills

**Deleted files (4):**

- `agents/implementor.md` (replaced by engineer)
- `agents/fixer.md` (replaced by engineer)
- `agents/guide.md` (lead handles via MCP tools directly)
- `agents/chat.md` (lead handles natively; planner covers structured evaluation)

**New TypeScript (1 file):**

- `mcp-server/src/features/orchestration/tools/orchestration-journal.ts`

**Symlinks (~19):**

- `rules/agent-*.md` → `references/agent-*.md` (skill registrations)
