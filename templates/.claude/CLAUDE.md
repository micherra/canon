# Canon Templates — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Structured output templates that agents must follow for consistent, parseable artifacts. Enforced by the `agent-template-required` rule — agents must read the template before producing output.

## Architecture
<!-- last-updated: 2026-03-22 -->

Each template is a markdown file with placeholder sections that agents fill in.

**Available templates:**

| Template | Used By | Purpose |
|----------|---------|---------|
| `claudemd-template.md` | scribe | CLAUDE.md structure |
| `design-decision.md` | architect | Architecture decisions with tradeoffs |
| `implementation-log.md` | implementor | Task implementation summary |
| `research-finding.md` | researcher | Research findings per dimension |
| `review-checklist.md` | reviewer | Code review output with violations |
| `security-assessment.md` | security | Vulnerability findings and remediation |
| `session-context.md` | orchestrator | Session-level context and blockers |
| `test-report.md` | tester | Test coverage and results |
| `context-sync-report.md` | scribe | Cross-iteration context sync |
| `wave-briefing.md` | orchestrator | Wave execution briefing |
| `design-document.md` | architect | Technical design with Canon alignment |
| `task-plan.md` | architect | Atomic task plan for implementors |
| `plan-index.md` | architect | Index of all task plans for a build |
| `pr-description.md` | shipper | PR description from build artifacts |
| `chat-brief.md` | chat | Structured brief for build handoff |

## Conventions
<!-- last-updated: 2026-03-22 -->

- Templates ensure downstream agents can reliably parse upstream output
- Never modify template structure without updating all consuming agents
- Templates use markdown with clear section headers and placeholder text
- Some templates now include optional evidence sections (`External Evidence`, `Evidence URLs`, `Verified Facts`, `Assumptions`) that downstream readers should preserve and tolerate when absent
