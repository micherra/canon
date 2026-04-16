---
done_criteria:
  - id: "dc-01"
    description: "5 runbook playbooks exist at skills/canon/runbooks/{flow-name}.md (fast-path, feature, epic, migrate, test-gap), each as markdown with YAML frontmatter, covering every non-terminal state in its legacy flow (including fragment-expanded states). 4 simple flows (review-only, security-audit, explore, adopt) handled via CLAUDE.md inline dispatch."
    testable: "ls skills/canon/runbooks/*.md returns 5 runbooks + _template.md + _README.md. For each, compare step IDs against expanded legacy flow states. Zero missing."
  - id: "dc-02"
    description: "Orchestration journal MCP tool exists with log_step and verify_completion, including flow_outcome tracking (domain_skills_loaded, review_verdict, fix_iterations). Registered behind CANON_AGENT_TEAMS_MODE=on."
    testable: "npm run build && npm test pass. Tool list with flag on shows log_step and verify_completion. With flag off, tools absent. log_step accepts domain_skills_loaded and outcome fields."
  - id: "dc-03"
    description: "11 agent definitions with maxTurns, permissionMode (plan or acceptEdits only), memory (6 agents: project), and skills frontmatter. Engineer consolidation and planner addition complete. Guide and chat removed. All skill references resolve."
    testable: "ls agents/canon-*.md returns 11 files. canon-implementor, canon-fixer, canon-guide, canon-chat absent. canon-engineer and canon-planner present. Every skill name resolves under skills/canon/references/."
  - id: "dc-04"
    description: "CLAUDE.md contains Agent Teams Orchestration section with 14 subsections, gated by CANON_AGENT_TEAMS_MODE=on. Includes inline dispatch for 4 removed flows, resume protocol, domain skill + template naming pattern, pre-build gate."
    testable: "Read CLAUDE.md. Confirm 14 subsections. Confirm inline dispatch table. Confirm resume protocol. Confirm flag boundary."
  - id: "dc-05"
    description: "5 hook scripts exist and are registered: PostCommit trailers, completion verify, SessionStart doc-check, SessionStart KG-check, SubagentStop scribe-queue."
    testable: "All 5 .sh files in hooks/canon-agent-teams/ exist, are executable, hooks.json registers them."
  - id: "dc-06"
    description: "All rules and domain skills registered under skills/canon/references/. 21 rule symlinks + agent-context-check rule + 6 migrated primers + 6 new domain skills."
    testable: "Symlinks resolve. 12 domain skill files present. agent-context-check exists."
  - id: "dc-07"
    description: "npm run build and npm test pass. Legacy path byte-identical when CANON_AGENT_TEAMS_MODE=off."
    testable: "npm run build && npm test exit 0. One legacy flow with flag off matches pre-Phase-1 baseline."
---

## Design: Phase 1 — Orchestration Guidance for Agent Teams Migration

### North Star

**Vision**: Claude orchestrates any Canon flow natively — using MCP tools as its toolkit, runbooks as playbooks, the orchestration journal as its checklist, and skills-preloaded agent definitions for dispatch — without touching the legacy drive_flow path.

**Done criteria**: See frontmatter above.

**Constraints**:
- Additions-only except: one new TypeScript file (~80-120 lines), agent definition body updates for engineer consolidation, removal of runtime Read instructions for rules
- Feature flag `CANON_AGENT_TEAMS_MODE` must keep legacy path byte-identical when off
- MUST NOT touch: `mcp-server/src/features/orchestration/` (except adding journal tool), `mcp-server/src/features/prompt-pipeline/`, `flows/`, existing MCP tools

### Approach

#### 1. Runbook playbooks (5 files + template)

Markdown files with YAML frontmatter — consistent with Canon's conventions (agents, principles, rules all use this format). A canonical template (`_template.md`) and README define the format. Four simple flows (review-only, security-audit, explore, adopt) are handled via CLAUDE.md inline dispatch.

5 runbooks: fast-path, feature (absorbs refactor as variant), epic, migrate, test-gap. Each covers every non-terminal state from its legacy flow including fragment-expanded states. Step IDs match legacy state names for traceability.

Frontmatter step structure: `id`, `agent` (from the 11-agent roster), `dispatch` (subagent/team), `mcp_tools`, `artifacts`, `hitl` (none/approval/checkpoint/on_failure). Body prose provides per-step guidance the lead follows via judgment.

All build runbooks include `context-sync` (scribe) and `learn` (learner) as mandatory final steps.

#### 2. Orchestration journal (~80-120 lines TypeScript)

The lead's checklist — bridges guidance and enforcement. Two MCP tools:
- `log_step({ workspace, step_id, agent_type, artifacts_expected, status, mcp_tools_called, domain_skills_loaded, outcome })` — records intent, progress, and quality signals
- `verify_completion({ workspace })` → returns steps_logged, steps_missing, artifacts_missing, flow_outcome (aggregated quality signals)

The `outcome` field captures: review_verdict, test_pass_rate, fix_iterations. The `domain_skills_loaded` field tracks which skills were used per step. Together these enable self-improving skills analysis (§4b P4 of the migration plan) — the learner can determine which skills correlate with better outcomes.

Registered behind feature flag. Completion verification hook calls `verify_completion` and blocks if steps or artifacts are missing.

#### 3. Agent roster changes (13 → 11)

**Delete 4:**
- `canon-implementor` + `canon-fixer` → merged into `canon-engineer` (same skill set, different prompting via dual-mode: implementation mode and fix mode)
- `canon-guide` → lead handles via MCP tools directly
- `canon-chat` → lead handles natively; planner covers structured evaluation

**Create 2:**
- `canon-engineer`: union tool list, `acceptEdits`, `memory: project`, preloaded with `agent-tdd-required` + `agent-minimal-fix` + 6 behavioral rules
- `canon-planner`: NEW role — pre-build gate. Clarifies requirements, challenges assumptions, evaluates alternatives, assesses value. `model: opus`, `plan` mode, `memory: project`. Produces structured brief via `planning-brief.md` template.

#### 4. Agent frontmatter updates (all 11)

Every agent gets: `maxTurns`, `permissionMode`, `memory` (where applicable), `skills`.

**Permission model — two values, works on all plans:**
- `plan`: read-only (researcher, architect, reviewer, security, planner)
- `acceptEdits`: auto-approve file edits in working directory (engineer, tester, scribe, shipper, learner, writer)
- `auto` NOT used — requires Team/Enterprise plans per Claude Code docs. When lead runs in auto mode, subagent `permissionMode` is overridden by the classifier anyway.

This replaces ~614 lines of legacy permission infrastructure (`tool-profiles.ts`, `trust-resolver.ts`, `worktree-settings.ts`).

**Memory — 6 agents with `memory: project`:**
- planner (feature history, value patterns), engineer (fix patterns, subsystem gotchas), researcher (codebase topology), architect (design decision history), scribe (doc landscape), learner (pattern mining)
- Reviewer excluded per `agent-cold-review` rule

#### 5. Skills: preloaded rules vs on-demand domain expertise

**Always preloaded** (via `skills:` frontmatter): behavioral rules + universal references. ~1.5-2.5k tokens per agent. Guarantees consistent behavior. `agent-context-check` preloaded into ALL agents — instructs self-serve context verification + domain skill loading.

**On-demand domain skills** (lead names in spawn prompt, agent reads): 12 domain skills under `skills/canon/references/`:
- 6 migrated from `domain-primers/`: backend-api, backend-data, frontend, testing, infrastructure, deprecation
- 6 new: authentication-security, migration-strategy, observability, error-handling, performance, devops-ci

Lead names relevant skills in spawn prompt: `"Relevant domain skills: backend-api, authentication-security."` Agent reads them on first turn per `agent-context-check`. Same pattern for templates: `"Use template: implementation-log."` Zero lead tool calls for context composition.

#### 6. CLAUDE.md orchestration section (14 subsections)

Placed after legacy section (annotated as `CANON_AGENT_TEAMS_MODE=off`). Explicit flag boundary at top.

Subsections: Intent Classification + Runbook Selection, Pre-Build Gate, Setup, Resume Protocol, Domain Skill + Template Naming, MCP Tool Composition, Dispatch Framework, Journal Protocol, Post-Subagent Artifact Check, HITL Patterns, Post-Step Effects, Completion Checklist, Commit Provenance, Error Handling.

Intent table covers: 5 runbook flows + 6 inline dispatches (review, security, explore, adopt, principle, learn) + resume + vague requests → planner.

#### 7. Enforcement and automation hooks (5 scripts)

- `post-commit-trailers.sh` — PostCommit: validates Canon-Workflow trailer (warns, can't block retroactively)
- `completion-verify.sh` — called at flow end: journal verification, blocks if incomplete
- `session-start-doc-check.sh` — SessionStart: compares HEAD vs `.canon/last-scribe-commit`
- `session-start-kg-check.sh` — SessionStart: checks `knowledge-graph.db` exists and is fresh
- `post-engineer-scribe.sh` — SubagentStop: queues scribe after canon-engineer completes

### Canon alignment

- **simplicity-first** — 5 runbooks (not 10). Markdown with frontmatter (not a new format). Journal is ~80-120 lines. Two permission values (not a trust computation engine).
- **information-hiding** — Each runbook encapsulates one flow. Each agent definition encapsulates one role. Domain skills are on-demand, not bloating every spawn.
- **least-privilege-access** — `plan` for read-only roles, `acceptEdits` for writers. No `auto` dependency.
- **externalize-configuration** — Feature flag is an env var. Skills are declarative frontmatter. Domain skills are file-based.
- **refactoring-integrity** — Engineer consolidation is a genuine merge. Guide/chat removal is justified by the lead having native capability.

### Decisions made

1. **5 runbooks, not 10** — simple flows (review, security, explore, adopt) handled as CLAUDE.md inline dispatch. A 1-step runbook is ceremony without value. (simplicity-first)
2. **Markdown with YAML frontmatter** — consistent with Canon's convention for agents, principles, rules, templates. Not pure YAML. (patterns-need-justification)
3. **Agent roster 13 → 11** — delete 4 (implementor, fixer, guide, chat), create 2 (engineer, planner). Engineer merges overlapping roles. Planner adds the "should we?" gate. Guide/chat are native lead capabilities. (simplicity-first, refactoring-integrity)
4. **Permission model: plan + acceptEdits only** — no `auto` mode (requires Team/Enterprise per Claude Code docs). `acceptEdits` works on all plans and is scoped to working directory. Replaces ~614 lines of `tool-profiles.ts` + `trust-resolver.ts` + `worktree-settings.ts`. (simplicity-first, least-privilege-access)
5. **Skills: preloaded rules, on-demand domains** — rules always in context (~200 tokens each, always relevant). Domain skills named by lead, read by agent. Avoids bloating every spawn with irrelevant domain context. (information-hiding)
6. **Journal with flow_outcome tracking** — captures domain_skills_loaded, review_verdict, fix_iterations. Enables self-improving skills analysis (§4b P4). Data foundation from day one. (explicit-contracts)
7. **Lead names, agent loads** — lead names domain skills and templates in spawn prompt. Agent reads them on first turn. Zero lead tool calls for context composition. Lead's context stays clean. (simplicity-first)
8. **Feature flag is CLAUDE.md-level** — no TypeScript reads the flag except journal tool registration. (simplicity-first, externalize-configuration)
9. **6 agents with memory: project** — planner, engineer, researcher, architect, scribe, learner. Cross-session learning as a core capability. Reviewer excluded per agent-cold-review. (information-hiding)
10. **agent-context-check as a preloaded skill** — delivers self-serve context + domain skill loading without modifying agent instruction bodies. (information-hiding)

### Open questions for user

None. The plan has been through 4 review cycles and all questions are resolved.
