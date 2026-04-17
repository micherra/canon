# Canon Runbooks

Runbooks are lightweight playbooks the Canon lead reads as guidance when orchestrating a flow. Each runbook describes the recommended step sequence for one flow (e.g., `fast-path`, `feature`, `epic`, `migrate`, `test-gap`). Runbooks are **not executable** — Claude reads them, uses judgment, and adapts as the task requires. They do **not** replace the legacy prompt pipeline: per §7 #6 of the migration plan, the v2 architecture does not build a plan-time prompt pipeline at all. The lead composes spawn prompts directly from MCP tool results, named skills, named templates, and its conversational understanding. Runbooks contribute *guidance* (sequence, dispatch choice, expected artifacts, HITL posture) — not templated prompt content.

Four simpler flows (`review-only`, `security-audit`, `explore`, `adopt`) are handled via CLAUDE.md inline dispatch and do not have runbook files. See §2.2 of `docs/agent-teams-migration-plan-v2.md`.

## Format

**Runbooks are markdown files with YAML frontmatter.** This matches Canon's existing convention: agents (`agents/*.md`), principles (`principles/**/*.md`), rules (`rules/*.md`), and templates (`templates/*.md`) all use this format. The frontmatter carries structured step metadata the orchestration journal consumes. The body carries prose guidance for the lead.

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
    mcp_tools:          # MCP tools the lead calls BEFORE spawning. May be [] when the agent fully self-serves.
      - tool_name
    artifacts:          # Expected output paths (workspace-relative, or .canon/-relative where noted)
      - "path/to/output.md"
    hitl: none | approval | checkpoint | on_failure
    skip_when: null | string   # Optional. Natural-language condition the lead evaluates.
```

### Field semantics

**`name`** — Flow key. Must match the runbook filename (without `.md`) and the flow key in CLAUDE.md's intent classification table.

**`description`** — Human-readable one-liner describing when this flow is used.

**`tier`** — Rough scale indicator for the lead's routing decisions and passed to `init_workspace` (see phase1-09). `small` → fast-path-style flows; `medium` → single-wave features; `large` → epics and migrations with multiple waves.

**`steps[]`** — Ordered list of step definitions. Order is the recommended default; the lead MAY reorder or skip based on judgment, but MUST log deviations via `log_step`.

**`steps[].id`** — Stable identifier used as the `step_id` argument to `log_step`. IDs match legacy flow state names for traceability between the old state machine and new journal entries. Every entry in the orchestration journal ties back to a `steps[].id` here.

**`steps[].agent`** — The agent type the lead spawns for this step. Must be a valid entry in the Canon agent roster (`agents/canon-*.md`). The lead uses this field to pick the `subagent_type` when calling the Agent tool. `null` is permitted for gate-only steps where the lead runs checks directly (no spawn).

**`steps[].dispatch`** — How the lead spawns the agent for this step (see §2.5 "Dispatch framework" of the migration plan):
- `subagent` — spawn a single agent via the Agent tool. Use for sequential steps, focused tasks, single artifact. Examples: research, design, review, context-sync, learn.
- `team` — create an agent team for parallel wave execution. Use when multiple teammates claim tasks from a shared task list and coordinate via the Mailbox. Examples: parallel implementation across files within a wave.

**`steps[].mcp_tools`** — MCP tools the lead should call BEFORE spawning the agent, to compose context (principles, file context, KG summaries). This is the lead's pre-spawn checklist, not a declaration of every tool the agent might use. An empty array is valid — some agents (scribe, learner) fully self-serve and need no lead-side pre-composition. Agents also have MCP access and self-serve missing context (see §2.5 "Agent self-serve context" of the migration plan), but the primary path is lead-composed.

**`steps[].artifacts`** — Expected output paths. Workspace-relative by default (`plans/${slug}/SUMMARY.md`); `.canon/`-relative or absolute when the artifact legitimately lives outside the workspace (e.g., `.canon/proposed-learnings/${timestamp}/`). After the agent returns, the lead performs a **post-subagent artifact check**: verifies each listed path exists on disk before proceeding. Missing artifacts block progress and trigger a retry or HITL. The completion verification hook (`verify_completion`) aggregates these checks at flow end.

**`steps[].hitl`** — Human-in-the-loop posture for this step. Maps to Claude's native HITL patterns (see §2.2 and §2.6 of the migration plan — Claude handles HITL natively; there is no custom breakpoint vocabulary):
- `none` — lead proceeds without user interaction
- `approval` — lead presents the artifact to the user and waits for explicit approval before proceeding (e.g., plan approval after design)
- `checkpoint` — lead surfaces a summary mid-flow so the user can redirect; no blocking approval required
- `on_failure` — lead only interrupts the user if the step fails (e.g., review verdict is not clean, fix loop exhausts retries)

**`steps[].skip_when`** — Optional. `null` means the step always runs. A natural-language string (e.g., `"all changes are internal/test-only/config"`) describes a condition the lead evaluates via judgment per §3 #27 of the migration plan: *"Claude evaluates skip conditions via judgment. Reads artifacts, checks file scope, decides whether to skip. Richer than pattern-matched conditions."* The string is advisory — not parsed, not pattern-matched. If a step is mandatory for this flow, omit the field or set it to `null`. If the lead skips a step, it must still log the step via `log_step` with `status: "skipped"` and the reason.

## Body Structure

The body is prose guidance for the lead. It is NOT executable — Claude reads it and adapts via judgment. Three required sections:

### Overview

One paragraph describing when this flow is used, what it produces, and how long it typically takes.

### Steps

One `### {step-id}` H3 subsection per entry in `steps[]`, in the same order.

**The body covers the *why*, *when-to-skip*, and *coordination notes*. It does NOT restate the frontmatter.** Machine-readable fields (`mcp_tools`, `artifacts`, `dispatch`, `hitl`, `skip_when`) live in frontmatter; the body exists to give the lead enough context to make judgment calls the frontmatter can't capture.

For each step's prose, cover what applies:

- **Intent** — one or two sentences on what this step accomplishes and why it exists in this flow.
- **Composition hints beyond `mcp_tools`** — e.g., which domain skills to name in the spawn prompt, which template to reference. Do NOT list the MCP tools already in frontmatter.
- **Skip when** — plain-language elaboration of the `skip_when` frontmatter value. If the step is always mandatory, state so explicitly ("Skip when: never").
- **Wave coordination** (for `dispatch: team` steps only) — how teammates coordinate (Mailbox, shared task list, `TaskCompleted` hooks), how the lead merges worktrees, inter-wave gates.
- **HITL coordination** (for `hitl: approval` or `checkpoint` steps only) — what the lead presents and what user response unblocks progression.

Do not repeat paths from `artifacts`; do not re-list tools from `mcp_tools`. If you catch yourself writing "**Expected output:** `path/X.md`" or "**What to compose:** call `get_principles`...", delete it — the frontmatter is authoritative.

### Completion

A short numbered checklist the lead runs after all steps complete. Every build runbook's Completion section MUST include:

1. `verify_completion({ workspace })` — journal verification (blocks on missing steps or artifacts)
2. `update_board({ operation: "complete_flow" })` — flow analytics
3. Verify file claims released
4. Evaluate learn gate (may have already run if the runbook includes a `learn` step)

Individual runbooks may add steps (e.g., ship-readiness check for `epic`).

> *Note:* When CLAUDE.md's agent-teams orchestration section lands (Phase 1 criterion `dc-04`), this checklist may centralize there and runbooks will only add flow-specific completion steps. Until then, every runbook includes the checklist.

## How Runbooks Connect to the Rest of Canon

### Journal (`log_step` / `verify_completion`)

Each `steps[].id` is the canonical `step_id` for journal entries. The lead calls `log_step({ workspace, step_id, agent_type, artifacts_expected, ... })` before spawning and again with `status: "completed"` after the agent returns. Skipped steps are logged with `status: "skipped"` and a reason. At flow end, `verify_completion` cross-references logged steps against the runbook's `steps[]` and the `artifacts` paths on disk.

Because step IDs are stable and match legacy state names, existing analytics, drift reports, and roadmap items that reference state names continue to work post-migration.

### Dispatch framework

`steps[].dispatch` is the direct input to the lead's dispatch decision: `subagent` → Agent tool with a single spawn; `team` → agent team creation with N teammates and a shared task list. See §2.5 "Dispatch framework" of the migration plan for the full rationale.

### HITL

`steps[].hitl` tells the lead which native Claude HITL pattern to use at the end of this step. The lead does NOT rely on a custom breakpoint vocabulary — it uses Claude's plain conversational HITL (ask a question, wait for the user) or agent team plan approval mode.

### Artifacts and post-subagent verification

After every subagent returns, the lead checks each path in `steps[].artifacts` exists on disk (§2.8 of the migration plan). Subagents do not fire `TaskCompleted` hooks — the post-subagent check compensates. For `dispatch: team` steps, `TaskCompleted` hooks on teammates enforce the same contract.

### Skip conditions

`steps[].skip_when` is advisory text for the lead, not a parsed expression. The lead reads it, evaluates the condition against current state (artifacts, file scope, drift signals), and decides. A skipped step is still logged — `log_step({ ..., status: "skipped", reason: "..." })` — so `verify_completion` sees it and completion is not blocked on a legitimately-skipped step.

### What runbooks do NOT carry

- **Spawn prompt content.** The lead composes spawn prompts from MCP tool results, named skills, named templates, and conversational framing. Runbooks contribute guidance (what to compose, what artifact to expect), not templated prompt text. See §7 #6 of the migration plan.
- **Variable interpolation.** Placeholders like `${slug}` and `${task_id}` in `artifacts` paths are path segments the lead substitutes from workspace metadata — not a general templating mechanism. See §3 #23 of the migration plan ("variable interpolation: deprecate").
- **Tool profiles, worktree settings, or commit trailers.** These live in agent definitions (`permissionMode`, `tools`) and hooks (`post-commit-trailers.sh`), not in runbooks.

## Authoring Guidance

1. **Start from the legacy flow.** For each non-terminal state (including fragment-expanded states), create a corresponding step entry. Preserve the state name as `steps[].id` for traceability.
2. **Choose dispatch per §2.5 "Dispatch framework".** Sequential, single-artifact work → `subagent`. Parallel, multi-file work → `team`.
3. **List only the MCP tools the lead actually calls for that step.** Empty arrays are fine. If a tool is universal, state it in CLAUDE.md, not in every runbook.
4. **Be explicit about artifacts.** Every step must list the paths a downstream step or the reviewer will look for. Use `${slug}` and `${task_id}` where the path is task-scoped; `${timestamp}` where the output is time-keyed.
5. **Body prose is judgment-level guidance, not a script.** Describe intent, trade-offs, and skip conditions. Never restate frontmatter fields.
6. **Include `context-sync` and `learn` as final steps in every build runbook** (per §1 of the Phase 1 design). `_template.md` shows the canonical shape for both — copy the frontmatter structure and adapt the prose.
7. **Use `skip_when` for steps that may legitimately be skipped.** Natural language, not expressions. If the step is always mandatory, leave `skip_when: null`.

## Verification

To verify a runbook conforms to the format:

```bash
# Frontmatter parses as YAML
python3 -c "import yaml; yaml.safe_load(open('skills/canon/runbooks/<name>.md').read().split('---')[1])"

# Required body sections present
grep -E '^## (Overview|Steps|Completion)\b' skills/canon/runbooks/<name>.md | wc -l   # expect 3

# Every steps[].id has a matching ### heading in the body (compare frontmatter ids vs body H3s)
# No stray {slug} / {task_id} / {timestamp} (must use ${slug} / ${task_id} / ${timestamp}):
grep -nE '[^$]\{(slug|task_id|timestamp)\}' skills/canon/runbooks/<name>.md       # expect empty
```

The Phase 1 design criterion `dc-01` also requires each runbook's `steps[].id` set to cover every non-terminal state in the legacy flow, including fragment-expanded states. That criterion applies to the concrete runbooks (phase1-01..04), not to this template.
