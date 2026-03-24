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
| `canon-orchestrator` | Single entry point; classifies intent, drives flow state machine, spawns agents | opus |
| `canon-chat` | Project-aware conversational agent; discusses ideas, brainstorms, writes briefs for build handoff | sonnet |
| `canon-guide` | Answers questions, browses principles, shows status dashboards (read-only) | sonnet |
| `canon-architect` | Designs solutions; produces design decisions and task decomposition | opus |
| `canon-implementor` | Writes code per plan; writes unit tests | sonnet |
| `canon-tester` | Writes integration tests; fills coverage gaps | sonnet |
| `canon-researcher` | Investigates single research dimensions | sonnet |
| `canon-reviewer` | Reviews code for principle compliance | opus |
| `canon-security` | Security assessments on implemented code | sonnet |
| `canon-scribe` | Updates CLAUDE.md, context.md, CONVENTIONS.md post-implementation | sonnet |
| `canon-learner` | Analyzes patterns; suggests principle improvements | opus |
| `canon-fixer` | Fixes principle violations identified by reviewers | sonnet |
| `canon-shipper` | Handles final shipping decisions | sonnet |
| `canon-writer` | Writes documentation and content | sonnet |
| `canon-inspector` | Analyzes completed builds; produces cost/bottleneck/failure reports | sonnet |

## Conventions
<!-- last-updated: 2026-03-22 -->

- Each agent has defined read/write permissions enforced by the orchestrator
- Agents receive fresh context per spawn (no carryover between invocations)
- Agent output must follow templates from `templates/` (see `agent-template-required` rule)
- Agents log activity per `workspace-logging.md` protocol
