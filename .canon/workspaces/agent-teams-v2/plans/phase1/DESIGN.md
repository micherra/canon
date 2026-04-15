---
done_criteria:
  - id: "dc-01"
    description: "5 runbook playbooks exist at skills/canon/runbooks/{flow-name}.md (fast-path, feature, epic, migrate, test-gap), each covering every non-terminal state in its legacy flow definition (including fragment-expanded states). 4 simple flows (review-only, security-audit, explore, adopt) handled via CLAUDE.md inline dispatch."
    testable: "ls skills/canon/runbooks/*.md returns 5 runbooks + _template.md + _README.md. For each runbook, compare step IDs against the expanded state list from the corresponding flows/*.md + included fragments. Zero missing states."
  - id: "dc-02"
    description: "Orchestration journal MCP tool exists with log_step and verify_completion, registered behind CANON_AGENT_TEAMS_MODE=on"
    testable: "npm run build passes. npm test passes. Tool list inspection with flag on shows log_step and verify_completion. With flag off, tools are absent."
  - id: "dc-03"
    description: "11 agent definitions with maxTurns, permissionMode, memory, and skills frontmatter. Engineer consolidation and planner addition complete. Guide and chat removed. All skill references resolve. 6 agents have memory: project."
    testable: "ls agents/canon-*.md returns 11 files. canon-implementor.md, canon-fixer.md, canon-guide.md, canon-chat.md absent. canon-engineer.md and canon-planner.md present. YAML frontmatter parses for all. Every skill name resolves to a file under skills/canon/references/."
  - id: "dc-04"
    description: "CLAUDE.md contains Agent Teams Orchestration section with 14 subsections (pre-build gate + 11 orchestration subsections), gated by CANON_AGENT_TEAMS_MODE=on, with explicit flag boundary. Includes inline dispatch for 4 removed flows."
    testable: "Read CLAUDE.md. Confirm section exists with all 14 subsections including pre-build gate. Confirm inline dispatch table for review, security-audit, explore, adopt. Confirm legacy section annotated. Confirm flag boundary statement at top."
  - id: "dc-05"
    description: "5 hook scripts exist and are registered: PostCommit trailers, completion verify, SessionStart doc-check, SessionStart KG-check, SubagentStop scribe-queue"
    testable: "All 5 .sh files in hooks/canon-agent-teams/ exist, are executable, and hooks.json registers them."
  - id: "dc-06"
    description: "All rules referenced by agent skills: fields are registered as skills under skills/canon/references/"
    testable: "For each symlink in skills/canon/references/agent-*.md, verify it points to the corresponding rules/*.md file and is not broken."
  - id: "dc-07"
    description: "npm run build and npm test pass with zero new errors. Legacy path byte-identical when CANON_AGENT_TEAMS_MODE=off."
    testable: "npm run build && npm test exits 0. Run one legacy flow with flag off, compare output to pre-Phase-1 baseline."
---

## Design: Phase 1 — Orchestration Guidance for Agent Teams Migration

### North Star

**Vision**: Claude can orchestrate any Canon flow natively — using MCP tools as its toolkit, runbooks as playbooks, the orchestration journal as its checklist, and skills-preloaded agent definitions for dispatch — without touching or changing the legacy drive_flow path.

**Done criteria**: See frontmatter above.

**Constraints**:
- Additions-only except: one new TypeScript file (~50-80 lines), agent definition body updates for engineer consolidation, removal of runtime Read instructions for rules
- Feature flag `CANON_AGENT_TEAMS_MODE` must keep legacy path byte-identical when off
- MUST NOT touch: `mcp-server/src/features/orchestration/` (except adding journal tool), `mcp-server/src/features/prompt-pipeline/`, `flows/`, existing MCP tools

### Approach

#### 1. Runbook playbooks (5 files + template)

Each runbook is a markdown file with YAML frontmatter at `skills/canon/runbooks/{flow-name}.md` — consistent with Canon's convention for agents, principles, and rules. A canonical template (`_template.md`) defines the format so parallel implementors produce consistent output. Four simple flows (review-only, security-audit, explore, adopt) are handled via inline dispatch in CLAUDE.md — they don't need runbooks.

Runbook step structure:
- `id`: matches legacy state name (traceability)
- `agent`: which agent type to spawn (using the new 11-agent roster)
- `dispatch`: `subagent` (sequential) or `team` (parallel wave)
- `mcp_tools`: which Canon MCP tools the lead should call to compose context
- `artifacts`: expected output paths
- `hitl`: `none`, `approval`, `checkpoint`, or `on_failure`
- `skip_when`: optional plain-language skip condition
- `notes`: guidance for the lead

Runbooks are playbooks, not executable. Claude reads them for guidance and adapts via judgment.

#### 2. Orchestration journal (1 TypeScript file, ~50-80 lines)

The journal is the lead's checklist — the enforcement mechanism that makes CLAUDE.md guidance verifiable.

Two MCP tools:
- `log_step({ workspace, step_id, agent_type, artifacts_expected, status })` — records intent and progress
- `verify_completion({ workspace }) → { steps_logged, steps_missing, artifacts_missing }` — checks the checklist

The lead calls `log_step` before and after each spawn. The completion verification hook calls `verify_completion` and blocks if anything is missing. This provides an auditable record that survives context compaction.

Registered in `register-orchestration.ts` behind the feature flag. When `CANON_AGENT_TEAMS_MODE=off`, the tools don't appear.

#### 3. Engineer consolidation (canon-implementor + canon-fixer → canon-engineer)

**Rationale**: Same skill set (both write code), same core tools (Read/Write/Edit/Bash), same core principle (agent-fresh-context). The separation was a state-machine artifact — different states spawned different agents. In the "Canon as toolkit" model, Claude decides what to spawn based on context, not state type.

The merged agent operates in two modes selected by spawn prompt:
- **Implementation mode**: follows a task plan, writes code + tests, commits incrementally
- **Fix mode**: receives specific issues (test failures or principle violations), makes minimal targeted fixes

Both `agent-tdd-required` and `agent-minimal-fix` are preloaded as skills. The spawn prompt activates the relevant mode.

**What's preserved**: the fixer's diagnostic process (structured triage, graph-based risk assessment) and the implementor's discipline (TDD, incremental checkpoints) are both in the merged agent's body.

#### 4. Skills: preloaded rules vs on-demand domain expertise

Two distinct loading mechanisms for two types of knowledge:

**Always preloaded** (via `skills:` frontmatter): behavioral rules and universal references. Per Claude Code docs: "The full content of each skill is injected into the subagent's context." These are small (~200 tokens each) and always relevant to the agent's role. They guarantee consistent behavior without runtime Read calls.

Per-agent preload: `agent-context-check` + `status-protocol` for all agents, plus role-specific rules (e.g., `agent-tdd-required` for engineer, `agent-cold-review` for reviewer). Total: ~1.5-2.5k tokens per agent.

**On-demand domain skills** (loaded by lead at spawn time): domain expertise that varies by task. NOT listed in agent `skills:` frontmatter — injected into the spawn prompt by the lead based on the task's scope.

12 domain skill files consolidated under `skills/canon/references/`:
- 6 existing (moved from `domain-primers/`): `backend-api`, `backend-data`, `frontend`, `testing`, `infrastructure`, `deprecation`
- 6 new: `authentication-security`, `migration-strategy`, `observability`, `error-handling`, `performance`, `devops-ci`

Each is ~30-40 lines (~200 tokens). The lead reads the task, identifies relevant domains, reads the matching skill files, and includes them in the spawn prompt. Agents can also self-serve by reading skill files directly via `Read` tool.

The CLAUDE.md orchestration section documents which domain skills to load for each task type.

**Registration**: rules are symlinked from `rules/*.md` to `skills/canon/references/`. Domain primers are moved from `domain-primers/*.md` to `skills/canon/references/`. One directory for all reusable knowledge.

**agent-context-check**: a new rule preloaded into ALL agents. Instructs agents to verify they have Canon principles and to self-serve via MCP if their spawn prompt is missing context.

#### 5. New canon-planner agent

A new agent that the lead spawns before build flows when the request is vague, assumption-heavy, or lacks clear acceptance criteria. The planner clarifies requirements, challenges assumptions, evaluates alternatives, and assesses value proportionality. Produces a structured brief using a new `planning-brief.md` template. Uses `model: opus`, `permissionMode: plan`, `memory: project`.

#### 6. CLAUDE.md orchestration section

Twelve subsections: pre-build gate (spawn planner when request isn't ready), setup, MCP tool composition, dispatch framework, journal protocol, post-subagent artifact check, HITL patterns, post-step effects, completion checklist, commit provenance, error handling, and the explicit flag boundary. Also includes inline dispatch table for 4 removed flows (review, security-audit, explore, adopt).

The section is placed after the existing "Driving the State Machine" section and gated by an explicit flag boundary statement. The existing section is annotated as `(CANON_AGENT_TEAMS_MODE=off)`.

#### 7. Enforcement and automation hooks

Five hook scripts:
- `post-commit-trailers.sh` — PostCommit hook validating `Canon-Workflow` trailer presence.
- `completion-verify.sh` — called at flow end. Invokes `verify_completion` from the journal tool. Exit 2 if steps or artifacts missing.
- `session-start-doc-check.sh` — SessionStart hook. Compares HEAD against `.canon/last-scribe-commit`. Nudges lead if documentation may be stale.
- `session-start-kg-check.sh` — SessionStart hook. Checks if `knowledge-graph.db` exists and is fresh (computed_at_commit matches HEAD). If missing or stale, instructs lead to run `codebase_graph` before proceeding. Without a populated KG, `infer_domains`, `get_file_context`, `graph_query`, and `semantic_search` return nothing — agents operate blind.
- `post-engineer-scribe.sh` — SubagentStop hook. After `canon-engineer` completes, writes `pending-scribe.json` to workspace. Lead runs scribe before completing the flow.

### Canon alignment

- **simplicity-first** — Runbooks are markdown with YAML frontmatter. The journal is ~50 lines. No new runtime engine.
- **information-hiding** — Each runbook encapsulates one flow's knowledge. Each agent definition encapsulates one role's skills. The lead doesn't need to understand legacy state transitions.
- **least-privilege-access** — `permissionMode: plan` for read-only roles, `auto` only for roles that write. Agent tool lists are minimal per role.
- **externalize-configuration** — Feature flag is an env var. Runbook selection is data-driven. Skills are declarative frontmatter.
- **refactoring-integrity** — Engineer consolidation is a genuine merge of overlapping roles, not cosmetic.

### Decisions made

1. **Runbooks are markdown with YAML frontmatter, not executable** — consistent with Canon conventions (agents, principles, rules all use this format). No runtime engine, no parser. Claude reads them as guidance. (simplicity-first, patterns-need-justification)
2. **5 runbooks, not 10** — simple flows (review-only, security-audit, explore, adopt) handled via CLAUDE.md inline dispatch. A 1-step runbook is ceremony without value. (simplicity-first)
3. **Feature flag is CLAUDE.md-level in Phase 1** — no TypeScript reads the flag except the journal tool registration. (simplicity-first, externalize-configuration)
4. **Agent roster: 13 → 11** — delete 4 (implementor, fixer, guide, chat), create 2 (engineer, planner). Engineer merges overlapping code-writing roles. Planner adds the missing "should we build this?" gate. Guide and chat removed — lead handles natively. (simplicity-first, refactoring-integrity)
5. **Skills delivered via symlinks, not copies** — rules stay in `rules/` as source of truth. Symlinks in `skills/canon/references/` make them discoverable as skills. No file duplication. (information-hiding)
6. **The journal is the bridge between guidance and enforcement** — CLAUDE.md tells the lead what to do. The journal records what the lead actually did. The hook verifies the record. (explicit-contracts)
7. **6 agents get memory: project** — planner, engineer, researcher, architect, scribe, learner. Reviewer excluded per agent-cold-review. Cross-session learning is a core capability, not a future enhancement. (information-hiding)
8. **Domain skills are on-demand, not preloaded** — domain expertise varies by task. Preloading all 12 into every engineer spawn wastes ~2,400 tokens on irrelevant context. Instead, the lead reads task scope, loads relevant skills (~200 tokens each), and includes in spawn prompt. Agents can also self-serve. (simplicity-first, information-hiding)
9. **Scribe/learner automated via hooks** — SessionStart doc-check, SubagentStop scribe-queue, completion-verify ensures both ran. Not just runbook guidance — hook enforcement. (explicit-contracts)
10. **agent-context-check is a preloaded skill, not an instruction body change** — delivers the self-serve context behavior without modifying agent instruction bodies. (information-hiding)

### Open questions for user

None. Phase 1 scope is well-defined by the migration plan.
