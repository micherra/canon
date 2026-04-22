# Canon Agents — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-22 -->
Agent definitions for Canon's multi-agent build pipeline. Each markdown file defines a specialized Claude agent with its role, tools, permissions, and behavioral rules.

## Architecture
<!-- last-updated: 2026-04-22 -->

Each agent file uses YAML frontmatter (`name`, `description`, `model`, `color`, `maxTurns`, `permissionMode`, `memory`, `skills`, `tools`) followed by markdown instructions. Agents are spawned by the orchestrator during flow execution.

**Agent roster (11):**

| Agent | Role | Model |
|-------|------|-------|
| `architect` | Designs solutions; produces design decisions and task decomposition | opus |
| `engineer` | Executes code-writing work in implementation mode (per a plan) or fix mode (targeted bug or violation fixes) | sonnet |
| `learner` | Analyzes patterns; suggests principle improvements | sonnet |
| `planner` | Evaluates build requests pre-implementation; produces structured briefs that greenlight, redirect, or ask clarifying questions | opus |
| `researcher` | Investigates single research dimensions | sonnet |
| `reviewer` | Reviews code for principle compliance | opus |
| `scribe` | Updates CLAUDE.md, context.md, CONVENTIONS.md post-implementation | sonnet |
| `security` | Security assessments on implemented code | opus |
| `shipper` | Handles final shipping decisions | sonnet |
| `tester` | Writes integration tests; fills coverage gaps | sonnet |
| `writer` | Creates and edits Canon principles and agent-rules | sonnet |

## Conventions
<!-- last-updated: 2026-04-22 -->

- Each agent has a declarative `permissionMode` enforced by Claude Code:
  - **`plan`** — truly read-only. No `Write` / `Edit` / `Bash`-to-modify AND no MCP `write_*` / `update_*` tools. For agents that emit artifacts inline (the lead writes them): `planner`, `security`.
  - **`acceptEdits`** — auto-approves file edits and common filesystem commands scoped to the working directory. For agents that produce artifacts via MCP write tools (`architect` → `write_plan_index` / `write_design_brief` / `update_board`; `researcher` → `write_research_synthesis`; `reviewer` → `write_review`; `tester` → `write_test_report`; `learner` → writes to `.canon/learning.jsonl` and `.canon/proposed-learnings/`; `shipper` → PR description; `writer` → principle files) or that edit source files (`engineer`, `scribe`).
  - **Why not all `plan` for read-only roles?** Claude Code's `plan` mode blocks ALL write tools including MCP `write_*` — per [permission-modes](https://code.claude.com/docs/en/permission-modes.md). So the subset that genuinely can't write anything (no MCP write tools) stays on `plan`; everyone else is `acceptEdits`. Each agent's `tools:` list is the real allowlist.
- Each agent has a `maxTurns` budget appropriate to its role. A turn is one assistant message with tool calls; text-only responses don't consume a turn. Parallel tool calls in one message = 1 turn.
- Agents receive fresh context per spawn (no carryover between invocations).
- Agent output must follow templates from `templates/` (see `agent-template-required` rule). Agents producing templated artifacts preload that rule via `skills:`.
- **`skills:` ID convention (prefix-namespaced)**: every entry is prefixed by its source directory — `rule:<name>` resolves to `rules/<name>.md`, `ref:<name>` resolves to `references/<name>.md`, `primer:<name>` resolves to `primers/<name>.md`. The Canon MCP tool `resolve_agent_skills` reads the agent's frontmatter and returns the concatenated content; the lead injects that into the spawn prompt before calling `Agent`. Bare (unprefixed) names are accepted for backward compat — the resolver searches rules/ then references/ then primers/.
- Agents log activity per `workspace-logging.md` protocol.
- `engineer` has direct access to `mcp__canon__get_messages` and `mcp__canon__write_implementation_summary` for collaboration during wave execution.
- `engineer` documents JUSTIFIED_DEVIATIONs in the Canon Compliance section of the summary for auditing purposes.
- Agents with `memory: project` (planner, engineer, researcher, architect, scribe, learner, tester) persist agent memory across sessions; others do not.
