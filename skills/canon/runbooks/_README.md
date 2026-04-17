# Canon Runbooks

Runbooks are lightweight playbooks the Canon lead reads as guidance when orchestrating a flow. Each runbook describes the recommended step sequence for one flow (e.g., `fast-path`, `feature`, `epic`, `migrate`, `test-gap`). Runbooks are **not executable** — Claude reads them, uses judgment, and adapts as the task requires.

Four simpler flows (`review-only`, `security-audit`, `explore`, `adopt`) are handled via CLAUDE.md inline dispatch and do not have runbook files. See §2.2 of `docs/agent-teams-migration-plan-v2.md`.

## Format

**Runbooks are markdown files with YAML frontmatter.** This matches Canon's existing convention: agents (`agents/*.md`), principles (`principles/**/*.md`), rules (`rules/*.md`), and templates (`templates/*.md`) all use this format. The frontmatter carries the structured step metadata the orchestration journal consumes. The body carries prose guidance for the lead.

The canonical template is [`_template.md`](./_template.md). All runbooks in this directory MUST conform to it.

### Naming

- `_template.md` — the canonical template (this format reference)
- `_README.md` — this file (format documentation)
- `{flow-name}.md` — one runbook per build flow; filename matches the flow key used in CLAUDE.md's intent table

## Frontmatter Schema

```yaml
name: string            # Flow identifier (matches filename without .md)
description: string     # One-line purpose of the flow
tier: small | medium | large

steps:
  - id: string          # Unique within runbook. Matches legacy state name for traceability.
    agent: string       # Agent type from the 11-agent roster (e.g., canon-researcher, canon-engineer)
    dispatch: subagent | team
    mcp_tools:          # MCP tools the lead calls BEFORE spawning the agent for this step
      - tool_name
    artifacts:          # Expected output paths (relative to workspace root)
      - "path/to/output.md"
    hitl: none | approval | checkpoint | on_failure
```

### Field semantics

**`name`** — Flow key. Must match the runbook filename (without `.md`) and the flow key in CLAUDE.md's intent classification table.

**`description`** — Human-readable one-liner describing when this flow is used.

**`tier`** — Rough scale indicator for the lead's routing decisions. `small` maps to fast-path-style flows; `medium` to single-wave features; `large` to epics and migrations with multiple waves.

**`steps[]`** — Ordered list of step definitions. Order is the recommended default; the lead MAY reorder or skip based on judgment, but MUST log deviations via `log_step`.

**`steps[].id`** — Stable identifier used as the `step_id` argument to `log_step`. IDs match legacy flow state names for traceability between the old state machine and new journal entries. Every entry in the orchestration journal ties back to a `steps[].id` here.

**`steps[].agent`** — The agent type the lead spawns for this step. Must be a valid entry in the Canon agent roster (`agents/canon-*.md`). The lead uses this field to pick the `subagent_type` when calling the Agent tool.

**`steps[].dispatch`** — How the lead spawns the agent for this step (see §2.5 "Dispatch framework" of the migration plan):
- `subagent` — spawn a single agent via the Agent tool. Use for sequential steps, focused tasks, single artifact. Examples: research, design, review.
- `team` — create an agent team for parallel wave execution. Use when multiple teammates claim tasks from a shared task list and coordinate via the Mailbox. Examples: parallel implementation across files within a wave.

**`steps[].mcp_tools`** — MCP tools the lead should call BEFORE spawning the agent, to compose context (principles, file context, KG summaries). This is the lead's pre-spawn checklist. Agents also have MCP access and self-serve missing context (see §2.5 "Agent self-serve context" of the migration plan), but the primary path is lead-composed.

**`steps[].artifacts`** — Expected output paths (relative to the workspace root). After the agent returns, the lead performs a **post-subagent artifact check**: verifies each listed path exists on disk before proceeding to the next step. Missing artifacts block progress and trigger a retry or HITL. The completion verification hook (`verify_completion`) aggregates these checks at flow end.

**`steps[].hitl`** — Human-in-the-loop posture for this step. Maps to Claude's native HITL patterns (see §2.2 and §2.6 of the migration plan — Claude handles HITL natively; there is no custom breakpoint vocabulary):
- `none` — lead proceeds without user interaction
- `approval` — lead presents the artifact to the user and waits for explicit approval before proceeding (e.g., plan approval after design)
- `checkpoint` — lead surfaces a summary mid-flow so the user can redirect; no blocking approval required
- `on_failure` — lead only interrupts the user if the step fails (e.g., review verdict is not clean, fix loop exhausts retries)

## Body Structure

The body is prose guidance for the lead. It is NOT executable — Claude reads it and adapts via judgment. Three required sections:

### Overview

One paragraph describing when this flow is used, what it produces, and how long it typically takes.

### Steps

One `### {step-id}` H3 subsection per entry in `steps[]`, in the same order. Each step's prose guidance should cover:

- **What the step does** — one or two sentences.
- **What to compose before spawning** — which MCP tools to call and with what scope, mirroring the frontmatter's `mcp_tools` list in narrative form.
- **Expected output** — restates the `artifacts` contract in prose, often with a short rationale.
- **Skip when** (optional) — conditions under which the lead may omit this step. If the step is always required, say so explicitly ("Skip when: Never").
- **Wave notes** (for `dispatch: team` steps) — how teammates coordinate (Mailbox, shared task list, `TaskCompleted` hooks), how the lead merges worktrees, and any inter-wave gates.
- **HITL notes** (if `hitl: approval` or `checkpoint`) — what the lead presents and what user response unblocks progression.

The step prose does not have to repeat the frontmatter verbatim; it should explain the **why** and the **how**, while the frontmatter supplies the machine-readable **what**.

### Completion

A short numbered checklist the lead runs after all steps complete. Every build runbook's Completion section MUST include:

1. `verify_completion({ workspace })` — journal verification (blocks on missing steps or artifacts)
2. `update_board({ operation: "complete_flow" })` — flow analytics
3. Verify file claims released
4. Evaluate learn gate

Individual runbooks may add steps (e.g., ship-readiness check for `epic`).

## How Runbooks Connect to the Rest of Canon

### Journal (`log_step` / `verify_completion`)

Each `steps[].id` is the canonical `step_id` for journal entries. The lead calls `log_step({ workspace, step_id, agent_type, artifacts_expected, ... })` before spawning and again with `status: "completed"` after the agent returns. At flow end, `verify_completion` cross-references logged steps against the runbook's `steps[]` and the `artifacts` paths on disk.

Because step IDs are stable and match legacy state names, existing analytics, drift reports, and roadmap items that reference state names continue to work post-migration.

### Dispatch framework

`steps[].dispatch` is the direct input to the lead's dispatch decision: `subagent` → Agent tool with a single spawn; `team` → agent team creation with N teammates and a shared task list. See §2.5 "Dispatch framework" of the migration plan for the full rationale.

### HITL

`steps[].hitl` tells the lead which native Claude HITL pattern to use at the end of this step. The lead does NOT rely on a custom breakpoint vocabulary — it uses Claude's plain conversational HITL (ask a question, wait for the user) or agent team plan approval mode.

### Artifacts and post-subagent verification

After every subagent returns, the lead checks each path in `steps[].artifacts` exists on disk (§2.8 of the migration plan). Subagents do not fire `TaskCompleted` hooks — the post-subagent check compensates. For `dispatch: team` steps, `TaskCompleted` hooks on teammates enforce the same contract.

## Authoring Guidance

1. **Start from the legacy flow.** For each non-terminal state (including fragment-expanded states), create a corresponding step entry. Preserve the state name as `steps[].id` for traceability.
2. **Choose dispatch per §2.5 "Dispatch framework".** Sequential, single-artifact work → `subagent`. Parallel, multi-file work → `team`.
3. **List only the MCP tools that matter.** Every tool in `mcp_tools` should be one the lead calls for that specific step. If a tool is universal, state it in CLAUDE.md, not in every runbook.
4. **Be explicit about artifacts.** Every step must list the artifact paths a downstream step or the reviewer will look for. Use `${slug}` and `${task_id}` placeholders where the path is task-scoped.
5. **Body prose is judgment-level guidance, not a script.** Describe intent, trade-offs, and skip conditions. Do not write imperative pseudo-code.
6. **Include `context-sync` and `learn` as final steps** in every build runbook (per §1 of the Phase 1 design). These mandatory tail steps feed the scribe and the learner.

## Verification

To verify a runbook conforms to the format:

```bash
# Frontmatter parses as YAML
python3 -c "import yaml; yaml.safe_load(open('skills/canon/runbooks/<name>.md').read().split('---')[1])"

# Required body sections present
grep -E '^## (Overview|Steps|Completion)\b' skills/canon/runbooks/<name>.md | wc -l   # expect 3

# Every steps[].id has a matching ### heading in the body
```

The Phase 1 design criterion `dc-01` also requires each runbook's `steps[].id` set to cover every non-terminal state in the legacy flow, including fragment-expanded states. That criterion applies to the concrete runbooks (phase1-01..04), not to this template.
