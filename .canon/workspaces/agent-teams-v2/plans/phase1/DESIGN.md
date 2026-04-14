---
done_criteria:
  - id: "dc-01"
    description: "10 runbook playbooks exist at skills/canon/runbooks/{flow-name}.md, each covering every non-terminal state in its legacy flow definition (including fragment-expanded states)"
    testable: "For each runbook, compare step IDs against the expanded state list from the corresponding flows/*.md + included fragments. Zero missing states."
  - id: "dc-02"
    description: "Orchestration journal MCP tool exists with log_step and verify_completion, registered behind CANON_AGENT_TEAMS_MODE=on"
    testable: "npm run build passes. npm test passes. Tool list inspection with flag on shows log_step and verify_completion. With flag off, tools are absent."
  - id: "dc-03"
    description: "12 agent definitions (engineer consolidation complete) with maxTurns, permissionMode, and skills frontmatter. All skill references resolve."
    testable: "ls agents/canon-*.md returns 12 files. canon-implementor.md and canon-fixer.md absent. YAML frontmatter parses for all. Every skill name in skills: field resolves to a file under skills/canon/references/."
  - id: "dc-04"
    description: "CLAUDE.md contains Agent Teams Orchestration section with all 11 subsections, gated by CANON_AGENT_TEAMS_MODE=on, with explicit flag boundary"
    testable: "Read CLAUDE.md. Confirm section exists with all 11 subsections. Confirm legacy section annotated. Confirm flag boundary statement at top."
  - id: "dc-05"
    description: "PostCommit trailer hook and completion verification hook exist and are registered"
    testable: "hooks/canon-agent-teams/post-commit-trailers.sh and completion-verify.sh exist, are executable, and hooks.json registers them."
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

#### 1. Runbook playbooks (10 files + schema)

Each runbook is a YAML file at `skills/canon/runbooks/{flow-name}.md`. A canonical schema (`_template.md`) defines every field so parallel implementors produce consistent output.

Runbook step structure:
- `id`: matches legacy state name (traceability)
- `agent`: which agent type to spawn (using the new 12-agent roster)
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

#### 4. Skills preloading

Per the skills research, 21 rules and 6 references are preloaded into agent definitions via `skills` frontmatter. This eliminates runtime Read tool calls, guarantees rules are present (no silent skipping), and costs 2k-5.5k tokens per agent.

**Registration**: rules are symlinked from `rules/*.md` to `skills/canon/references/` so the `skills:` field can reference them by name.

**agent-context-check**: a new rule preloaded into ALL agents. Instructs agents to verify they have Canon principles for their target files and self-serve via MCP if their spawn prompt is missing context. This is the delivery mechanism for the self-serve context model (§2.5 of the migration plan).

**Domain primers**: all 6 primers (~1,200 tokens total) preloaded into `canon-engineer` and `canon-architect`. These are task-domain-agnostic agents that work across all domains.

#### 5. CLAUDE.md orchestration section

Eleven subsections covering: setup, MCP tool composition, dispatch framework, journal protocol, post-subagent artifact check, HITL patterns, post-step effects, completion checklist, commit provenance, error handling, and the explicit flag boundary.

The section is placed after the existing "Driving the State Machine" section and gated by an explicit flag boundary statement. The existing section is annotated as `(CANON_AGENT_TEAMS_MODE=off)`.

#### 6. Enforcement hooks

Two new hook scripts:
- `post-commit-trailers.sh` — PostCommit hook validating `Canon-Workflow` trailer presence. Warns on missing trailers (PostCommit cannot block retroactively).
- `completion-verify.sh` — called by the lead at flow end. Invokes `verify_completion` from the journal tool. Exit 2 if steps or artifacts missing.

### Canon alignment

- **simplicity-first** — Runbooks are flat YAML. The journal is ~50 lines. No new runtime engine.
- **information-hiding** — Each runbook encapsulates one flow's knowledge. Each agent definition encapsulates one role's skills. The lead doesn't need to understand legacy state transitions.
- **least-privilege-access** — `permissionMode: plan` for read-only roles, `auto` only for roles that write. Agent tool lists are minimal per role.
- **externalize-configuration** — Feature flag is an env var. Runbook selection is data-driven. Skills are declarative frontmatter.
- **refactoring-integrity** — Engineer consolidation is a genuine merge of overlapping roles, not cosmetic.

### Decisions made

1. **Runbooks are YAML playbooks, not executable** — no runtime engine, no parser. Claude reads them as guidance. (simplicity-first)
2. **Feature flag is CLAUDE.md-level in Phase 1** — no TypeScript reads the flag except the journal tool registration. The flag determines which CLAUDE.md section the lead follows. (simplicity-first, externalize-configuration)
3. **Engineer consolidation in Phase 1, not deferred** — the consolidation is needed for the skills preload map to be correct (can't preload implementation + fix skills into two separate agents without duplication). (simplicity-first)
4. **Skills delivered via symlinks, not copies** — rules stay in `rules/` as source of truth. Symlinks in `skills/canon/references/` make them discoverable as skills. No file duplication. (information-hiding)
5. **The journal is the bridge between guidance and enforcement** — CLAUDE.md tells the lead what to do. The journal records what the lead actually did. The hook verifies the record. Three layers working together. (explicit-contracts implied)
6. **All 6 domain primers preloaded into engineer + architect** — ~1,200 tokens is trivial. Eliminates runtime Read calls and conditional primer loading. (simplicity-first)
7. **Runbook step IDs match legacy state names** — direct traceability for Phase 2 validation. (explicit-contracts)
8. **agent-context-check is a preloaded skill, not an instruction body change** — delivers the self-serve context behavior without modifying agent instruction bodies. (information-hiding)

### Open questions for user

None. Phase 1 scope is well-defined by the migration plan.
