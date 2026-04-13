---
done_criteria:
  - id: "dc-01"
    description: "CLAUDE.md contains an 'Agent Teams Orchestration' section gated by CANON_AGENT_TEAMS_MODE=on that describes MCP tool composition, dispatch framework, HITL patterns, post-step effects, completion checklist, and commit provenance convention"
    testable: "Read CLAUDE.md; confirm the section exists, is under a feature-flag heading, and covers all six topics listed"
  - id: "dc-02"
    description: "10 runbook playbooks exist at skills/canon/runbooks/{flow-name}.yaml, one per flow type, each covering every state in its legacy flow definition"
    testable: "ls skills/canon/runbooks/*.yaml returns exactly 10 files; for each, compare step list against the corresponding flows/*.md state list and confirm full coverage"
  - id: "dc-03"
    description: "All 13 agent definitions in agents/*.md have tools allowlists that work for both subagent and teammate dispatch; roles with restricted tools that need Canon MCP access include mcpServers: [canon]"
    testable: "For each agents/*.md file, parse YAML frontmatter; confirm tools field exists; for definitions with restricted tool lists that omit mcp__canon__* tools, confirm mcpServers: [canon] is present"
  - id: "dc-04"
    description: "Feature flag CANON_AGENT_TEAMS_MODE is wired in CLAUDE.md conditional sections; when env var is unset or 'off', no agent-teams guidance is visible to the lead"
    testable: "With CANON_AGENT_TEAMS_MODE unset, read CLAUDE.md; confirm no runbook references, no agent-teams dispatch instructions appear; with CANON_AGENT_TEAMS_MODE=on, confirm they do appear"
  - id: "dc-05"
    description: "npm run build and npm test pass with zero new errors after all Phase 1 additions"
    testable: "Run npm run build && npm test in mcp-server/; zero exit code; no new test failures"
  - id: "dc-06"
    description: "With CANON_AGENT_TEAMS_MODE=off (or unset), running a legacy drive_flow produces byte-identical behavior to baseline"
    testable: "Run one legacy flow with flag off; compare artifacts against a pre-phase-1 baseline run"
---

## Design: Phase 1 — Orchestration Guidance for Agent Teams Migration

### North Star

**Vision**: Claude can orchestrate any Canon flow natively using runbook playbooks, MCP tools, and agent definitions -- without touching or changing the legacy drive_flow path.

**Done criteria**: See frontmatter above. These are the machine-readable exit conditions for Phase 1. When all are met, Phase 2 validation can begin.

**Constraints**:
- Additions only -- no code deletions, no behavior changes to existing files
- Feature flag `CANON_AGENT_TEAMS_MODE` must keep legacy `drive_flow` path byte-identical when off
- No new TypeScript code -- only markdown, YAML, and agent definition frontmatter updates
- Agent definitions must work for both subagent and teammate dispatch
- Runbooks are playbooks (guidance), not executable state machines
- MUST NOT touch: `mcp-server/src/features/orchestration/`, `mcp-server/src/features/prompt-pipeline/`, `flows/`, existing MCP tool implementations

### Approach

Phase 1 is a pure guidance layer. It produces four deliverable categories that together give Claude everything needed to orchestrate Canon flows natively when `CANON_AGENT_TEAMS_MODE=on`:

#### 1. CLAUDE.md Update -- Orchestration Discipline

Add a conditional section to CLAUDE.md that activates when `CANON_AGENT_TEAMS_MODE=on`. This section replaces the "Driving the State Machine" section's instructions with agent-teams orchestration discipline.

**Structure**: The new section is placed after the existing "Driving the State Machine" section and is clearly marked as the agent-teams alternative. When the flag is on, the lead reads the agent-teams section; when off (or unset), the existing drive_flow section governs.

**Contents** (six subsections):
1. **MCP Tool Composition** -- How the lead calls `get_principles`, `get_file_context`, `get_drift_report`, `graph_query` to assemble context before spawning agents. This replaces the 9-stage prompt pipeline.
2. **Dispatch Framework** -- When to use subagents (sequential pipeline steps) vs agent teams (parallel wave tasks). Decision table matching the migration plan's section 2.5.
3. **HITL Patterns** -- How to present results for user approval, handle merge conflicts, report gate failures. Replaces the five legacy breakpoint shapes.
4. **Post-Step Effects** -- Lead calls `store_pr_review`, runs contract-checker assertions, evaluates learn gate at completion. Replaces the effects executor.
5. **Completion Checklist** -- `update_board({ operation: "complete_flow" })`, release file claims, record metrics, evaluate learn gate.
6. **Commit Provenance Convention** -- Agents include Canon-Workflow/Agent/State/Task trailers. Format documented inline rather than injected by pipeline.

**Feature flag mechanism**: The flag is a CLAUDE.md authoring convention, not a code change. The section uses a clear heading like "## Agent Teams Orchestration (CANON_AGENT_TEAMS_MODE=on)" and the existing "Driving the State Machine" section is annotated as "## Driving the State Machine (Legacy -- CANON_AGENT_TEAMS_MODE=off or unset)". Claude reads CLAUDE.md and follows the section matching its env var. No TypeScript code reads the flag in Phase 1.

#### 2. Runbook Playbooks (10 files)

Each runbook is a YAML file at `skills/canon/runbooks/{flow-name}.yaml` containing:
- `name`: Flow name
- `description`: One-line purpose
- `tier`: small/medium/large/research/testing/review/security/adoption
- `steps`: Ordered list of step objects, each with:
  - `id`: Step identifier (matches legacy state name for traceability)
  - `agent`: Which agent type to spawn
  - `dispatch`: `subagent` or `team` (for wave steps)
  - `mcp_tools`: Which Canon MCP tools the lead should call to compose context before this step
  - `artifacts`: Expected output artifacts (file paths relative to workspace)
  - `hitl`: Whether this step has a user checkpoint (`approval`, `on_failure`, `none`)
  - `skip_when`: Optional skip condition described in plain language
  - `notes`: Guidance for the lead on how to handle this step

Runbooks are NOT executable. Claude reads them as a recommended step sequence and adapts based on what it finds. The YAML structure makes them machine-parseable for future tooling but they carry no runtime semantics in Phase 1.

**Mapping from flows to runbooks**: Each runbook covers every state in its legacy flow definition, including states pulled in from fragments (review-fix-loop, verify-fix-loop, pre-launch-check, ship-done, etc.). The mapping is:

| Flow | Key states to cover | Notes |
|------|-------------------|-------|
| fast-path | execute, pre-launch-check, ship, learn | Single-agent, simplest runbook |
| feature | design, implement (wave), context-sync, verify, fix-impl, review, fix-violations, pre-launch-check, ship, learn | First runbook with wave step |
| refactor | analyze, implement (wave), verify, fix-impl, context-sync, review, fix-violations, pre-launch-check, ship, learn | Behavior-preservation emphasis |
| epic | research (parallel), design (compete), implement (wave+consultations), context-sync, test, fix-impl, security, fix-security, review, fix-violations, pre-launch-check, ship, learn | Most complex; multi-wave, adaptive replan |
| migrate | research (parallel), design (compete), implement (wave), verify, fix-impl, security, fix-security, context-sync, review, fix-violations, pre-launch-check, ship, learn | Rollback emphasis |
| test-gap | scan, write-tests, fix-impl, review, fix-violations | No ship step |
| review-only | review | Single step, simplest |
| security-audit | security, review | Two steps |
| explore | research (parallel), synthesize | No implementation |
| adopt | scan, fix (parallel-per), rescan | No ship step |

#### 3. Agent Definition Updates

Audit all 13 agent definitions for subagent/teammate readiness. The key changes:

**Tool allowlist audit**: Every agent definition already has a `tools:` field. The concern from the migration plan (risk #4) is that restricted tool lists may inadvertently exclude Canon MCP tools when running as subagents. The fix:

- Agents that currently list specific `mcp__canon__*` tools (researcher, architect, reviewer, security, fixer, learner, chat, guide, implementor, tester): Already have the MCP tools they need. No change needed for these -- subagents inherit all tools including MCP by default, and the `tools` list restricts to only the listed tools. Since the listed tools already include the needed `mcp__canon__*` entries, they work correctly.
- The `tools` field serves double duty: for subagents it restricts inherited tools; for teammates the definition's `tools` field is honored per agent teams docs.

**New frontmatter fields**: Add fields that enable richer subagent/teammate dispatch:
- `maxTurns`: Effort budget per agent type. Researchers get a lower budget (15-20 turns), implementors get higher (40-50 turns). This replaces `max_iterations` / `max_revisions` from the flow YAML.
- `permissionMode`: Per-role permission setting. Researchers get `plan` (read-only), implementors get `auto` (can write), reviewers get `plan`.
- `skills`: Role-specific rules and references preloaded into agent context at startup. Per Claude Code docs: "The full content of each skill is injected into the subagent's context, not just made available for invocation." This eliminates runtime Read tool calls for rules, guarantees rules are present, and reduces per-spawn token overhead (~2,000–5,500 tokens per agent). Each rule/reference file is registered as a named skill under `skills/canon/`.

These fields are informational in Phase 1 -- the legacy drive_flow path does not read them. They become operational when `CANON_AGENT_TEAMS_MODE=on` and the lead reads agent definitions to configure subagent spawns.

**Behavioral change (minor)**: Runtime `Read` instructions for rules in agent markdown bodies are removed where they exist, since the content is now preloaded via `skills`. The rule files themselves remain for human reference. This has no effect on the legacy path (which does not use `skills` frontmatter).

#### 4. Feature Flag Wiring

The feature flag `CANON_AGENT_TEAMS_MODE` is an environment variable. In Phase 1:
- It is documented in CLAUDE.md as the switch between legacy and agent-teams orchestration.
- No TypeScript code reads it. The flag's effect is entirely in which CLAUDE.md section the lead follows.
- Default is `off` (or unset), meaning the lead uses the existing "Driving the State Machine" section.
- When set to `on`, the lead uses the "Agent Teams Orchestration" section instead.

This is deliberately minimal. Phase 2 may add code-level flag checks if needed, but Phase 1 proves the guidance layer works before adding any code complexity.

### Canon alignment

- **simplicity-first** -- Runbooks are plain YAML playbooks, not a new runtime. No code, no parsing, no execution engine. Claude reads them as guidance. The feature flag is a CLAUDE.md convention, not a code branch.
- **information-hiding** -- Each runbook encapsulates the knowledge of one flow type. The lead does not need to understand flow YAML schema, fragment inclusion, or state machine transitions -- the runbook presents the recommended step sequence directly.
- **explicit-transaction-boundaries** -- Honored by the completion checklist design: the lead calls `update_board complete_flow`, releases claims, and records metrics as an explicit sequence. No implicit cleanup.
- **externalize-configuration** -- The feature flag is an environment variable, keeping the configuration external to code.
- **patterns-need-justification** -- Runbooks follow a consistent YAML structure across all 10 flow types. The structure is justified by the need for machine-parseability (future tooling) and human readability.

### File structure

**New files:**
- `CLAUDE.md` -- Updated (not new) with agent-teams orchestration section
- `skills/canon/runbooks/fast-path.yaml` -- Fast-path runbook
- `skills/canon/runbooks/feature.yaml` -- Feature runbook
- `skills/canon/runbooks/refactor.yaml` -- Refactor runbook
- `skills/canon/runbooks/epic.yaml` -- Epic runbook
- `skills/canon/runbooks/migrate.yaml` -- Migrate runbook
- `skills/canon/runbooks/test-gap.yaml` -- Test-gap runbook
- `skills/canon/runbooks/review-only.yaml` -- Review-only runbook
- `skills/canon/runbooks/security-audit.yaml` -- Security-audit runbook
- `skills/canon/runbooks/explore.yaml` -- Explore runbook
- `skills/canon/runbooks/adopt.yaml` -- Adopt runbook

**Modified files (frontmatter only):**
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

### Decisions made

1. **Feature flag is CLAUDE.md-only, not code** -- The flag determines which CLAUDE.md section Claude follows. No TypeScript reads it. Rationale: Phase 1 is additions-only with zero behavior change. Adding code to read an env var would touch `mcp-server/src/` which is out of scope. The CLAUDE.md conditional section approach is simpler and achieves the same gating effect. (simplicity-first)

2. **Runbooks are YAML, not executable** -- Runbooks use YAML for structure but carry no runtime semantics. Claude reads them for guidance and uses judgment to adapt. Rationale: An executable runbook engine would be a new state machine, which is exactly what we are migrating away from. YAML gives structure for machine-parseability without runtime coupling. (simplicity-first, information-hiding)

3. **Agent definition updates are frontmatter-only** -- Only YAML frontmatter fields (maxTurns, permissionMode) are added. Agent instruction bodies are untouched. Rationale: The existing instructions already describe agent behavior correctly. The new frontmatter fields enable richer dispatch configuration that the agent-teams path can use. Changing instruction bodies would risk breaking the legacy path. (refactoring-integrity)

4. **Runbook step IDs match legacy state names** -- Each runbook step uses the same ID as the legacy flow state it corresponds to. Rationale: Enables direct comparison during Phase 2 validation and makes the mapping auditable. (explicit-contracts implied by the review/audit requirement)

5. **No mcpServers field needed for existing definitions** -- After auditing all 13 agent definitions, none need `mcpServers: [canon]` added. Agents that need Canon MCP tools already list them explicitly in their `tools` field. Agents without Canon MCP tools in their `tools` list (scribe, shipper, writer) do not need Canon MCP access for their role. When spawned as subagents, the `tools` list restricts inherited tools to exactly what is listed. This is correct behavior -- a scribe does not need `get_principles`. (least-privilege-access)

6. **Completion checklist in CLAUDE.md rather than a separate file** -- The post-flow completion steps (update_board, release claims, record metrics, learn gate) are documented inline in the CLAUDE.md agent-teams section rather than as a separate reference document. Rationale: The steps are short (5-7 items) and the lead needs them in its primary context, not buried in a reference file. (simplicity-first)

### Open questions for user

- None. Phase 1 is well-defined by the migration plan's section 4. All architectural decisions are straightforward additions-only changes.
