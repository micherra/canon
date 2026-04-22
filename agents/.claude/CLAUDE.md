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

- Each agent has a declarative `permissionMode` (`plan` for read-only roles, `acceptEdits` for roles that write files) enforced by Claude Code.
- Each agent has a `maxTurns` budget appropriate to its role.
- Agents receive fresh context per spawn (no carryover between invocations).
- Agent output must follow templates from `templates/` (see `agent-template-required` rule).
- Agents log activity per `workspace-logging.md` protocol.
- `engineer` has direct access to `mcp__canon__get_messages` and `mcp__canon__write_implementation_summary` for collaboration during wave execution.
- `engineer` documents JUSTIFIED_DEVIATIONs in the Canon Compliance section of the summary for auditing purposes.
- Agents with `memory: project` (planner, engineer, researcher, architect, scribe, learner) persist agent memory across sessions; others do not.
