# Canon Agents — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Agent definitions for Canon's multi-agent build pipeline. Each markdown file defines a specialized Claude agent with its role, tools, permissions, and behavioral rules.

## Architecture
<!-- last-updated: 2026-03-22 -->

Each agent file uses YAML frontmatter (name, description, model, color, tools) followed by markdown instructions. Agents are spawned by the orchestrator during flow execution.

**Agent roster:**

| Agent | Role | Model |
|-------|------|-------|
| `canon-orchestrator` | Single entry point; classifies intent, drives flow state machine, spawns agents | sonnet |
| `canon-chat` | Project-aware conversational agent; discusses ideas, brainstorms, writes briefs for build handoff | sonnet |
| `canon-guide` | Answers questions, browses principles, shows status dashboards (read-only) | sonnet |
| `canon-architect` | Designs solutions; produces design decisions and task decomposition | opus |
| `canon-implementor` | Writes code per plan; writes unit tests | sonnet |
| `canon-tester` | Writes integration tests; fills coverage gaps | sonnet |
| `canon-researcher` | Investigates single research dimensions | sonnet |
| `canon-reviewer` | Reviews code for principle compliance | opus |
| `canon-security` | Security assessments on implemented code | opus |
| `canon-scribe` | Updates CLAUDE.md, context.md, CONVENTIONS.md post-implementation | sonnet |
| `canon-learner` | Analyzes patterns; suggests principle improvements | sonnet |
| `canon-fixer` | Fixes failing tests and principle violations identified by reviewers | sonnet |
| `canon-shipper` | Handles final shipping decisions | sonnet |
| `canon-writer` | Creates and edits Canon principles and agent-rules | sonnet |
| `canon-inspector` | Analyzes completed builds; produces cost/bottleneck/failure reports | sonnet |

## Conventions
<!-- last-updated: 2026-03-24 -->

- Each agent has defined read/write permissions enforced by the orchestrator
- Agents receive fresh context per spawn (no carryover between invocations)
- Agent output must follow templates from `templates/` (see `agent-template-required` rule)
- Agents log activity per `workspace-logging.md` protocol
- `canon-implementor` has direct access to `mcp__canon__post_wave_bulletin` and `mcp__canon__get_wave_bulletin` for near-real-time collaboration during wave execution
- `canon-implementor` documents JUSTIFIED_DEVIATIONs in the Canon Compliance section of the summary for auditing purposes
