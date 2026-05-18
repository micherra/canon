# Canon Templates — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Structured output templates that agents must follow for consistent, parseable artifacts. Enforced by the `agent-template-required` rule — agents must read the template before producing output.

## Architecture
<!-- last-updated: 2026-05-17 (renderer-review.md added) -->

Each template is a markdown file with placeholder sections that agents fill in.

**Available templates:**

| Template | Used By | Purpose |
|----------|---------|---------|
| `claudemd-template.md` | scribe | CLAUDE.md structure |
| `design-decision.md` | architect | Architecture decisions with tradeoffs |
| `implementation-log.md` | engineer | Task implementation summary — required `#### Criteria Coverage` table maps every task-plan acceptance criterion to a disposition (`covered`, `descoped`, `partial`); reviewer checks this in Stage 3 compliance cross-check |
| `review-checklist.md` | reviewer | Code review output with violations |
| `security-assessment.md` | security | Vulnerability findings and remediation |
| `session-context.md` | orchestrator | Session-level context and blockers |
| `test-report.md` | tester | Test coverage and results |
| `context-sync-report.md` | scribe | Cross-iteration context sync |
| `wave-briefing.md` | orchestrator | Wave execution briefing |
| `wave-report.md` | orchestrator | Structured wave execution report for inter-wave handoff |
| `design-document.md` | architect | Technical design with Canon alignment |
| `task-plan.md` | architect | Atomic task plan for engineers — required `### Brief Coverage` table maps every runbook requirement to a task element with disposition (`covered`, `descoped`, `partial`); missing or empty table is a plan defect that blocks progression |
| `plan-index.md` | architect | Index of all task plans for a build |
| `planning-brief.md` | deprecated | DEPRECATED — was pre-build evaluation. Kept for backward compat |
| `runbook.md` | architect | Runbook step sequence for orchestrator execution |
| `pr-description.md` | shipper | PR description from build artifacts |
| `chat-brief.md` | chat | Structured brief for build handoff |
| `migration-state.md` | orchestrator | Migration state handoff for multi-wave coordination |
| `renderer-planning-brief.md` | orchestrator | Renderer spawn prompt — converts planning brief markdown to `planning-brief.html`; pure markdown, no MCP calls |
| `renderer-design.md` | orchestrator | Renderer spawn prompt — converts design document + task DAG YAML to `design.html`; pure markdown, no MCP calls |
| `renderer-review.md` | orchestrator | Renderer spawn prompt — converts review markdown to `review.html`; references `file-detail-card.html` (Canvas-based) and `blast-radius-tree.html`; requires MCP calls (`show_pr_impact`, `get_file_context`) |
| `sharpened-request.md` | pm-orchestrator | PM-to-architect hand-off artifact with Problem, Direction, Scope Boundaries, Acceptance Criteria, and Not Doing sections |

## Conventions
<!-- last-updated: 2026-03-22 -->

- Templates ensure downstream agents can reliably parse upstream output
- Never modify template structure without updating all consuming agents
- Templates use markdown with clear section headers and placeholder text
- Some templates now include optional evidence sections (`External Evidence`, `Evidence URLs`, `Verified Facts`, `Assumptions`) that downstream readers should preserve and tolerate when absent
