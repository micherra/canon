# Canon Agents — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-09 -->
Agent definitions for Canon's multi-agent build pipeline. Each markdown file defines a specialized Claude agent with its role, tools, permissions, and behavioral rules.

## Architecture
<!-- last-updated: 2026-04-09 -->

Each agent file uses YAML frontmatter (name, description, model, color, tools) followed by markdown instructions. Agents are spawned by the orchestrator during flow execution.

**Agent roster:**

| Agent | Role | Model |
|-------|------|-------|
| `architect` | Designs solutions; produces design decisions and task decomposition | opus |
| `chat` | Project-aware conversational agent; discusses ideas, brainstorms, writes briefs for build handoff | sonnet |
| `fixer` | Fixes failing tests and principle violations identified by reviewers | sonnet |
| `guide` | Answers questions, browses principles, shows status dashboards (read-only) | sonnet |
| `implementor` | Writes code per plan; writes unit tests | sonnet |
| `learner` | Analyzes patterns; suggests principle improvements | sonnet |
| `researcher` | Investigates single research dimensions | sonnet |
| `reviewer` | Reviews code for principle compliance | opus |
| `scribe` | Updates CLAUDE.md, context.md, CONVENTIONS.md post-implementation | sonnet |
| `security` | Security assessments on implemented code | opus |
| `shipper` | Handles final shipping decisions | sonnet |
| `tester` | Writes integration tests; fills coverage gaps | sonnet |
| `writer` | Creates and edits Canon principles and agent-rules | sonnet |

## Conventions
<!-- last-updated: 2026-04-09 -->

- Each agent has defined read/write permissions enforced by the orchestrator
- Agents receive fresh context per spawn (no carryover between invocations)
- Agent output must follow templates from `templates/` (see `agent-template-required` rule)
- Agents log activity per `workspace-logging.md` protocol
- `implementor` has direct access to `mcp__canon__post_message` and `mcp__canon__get_messages` for collaboration during wave execution
- `implementor` documents JUSTIFIED_DEVIATIONs in the Canon Compliance section of the summary for auditing purposes
