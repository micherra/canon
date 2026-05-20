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
| `design-document.md` | architect | Technical design with Canon alignment |
| `task-plan.md` | architect | Atomic task plan for engineers — required `### Brief Coverage` table maps every runbook requirement to a task element with disposition (`covered`, `descoped`, `partial`); missing or empty table is a plan defect that blocks progression |
| `plan-index.md` | architect | Index of all task plans for a build |
| `runbook.md` | architect | Runbook step sequence for orchestrator execution |
| `pr-description.md` | shipper | PR description from build artifacts |
| `chat-brief.md` | chat | Structured brief for build handoff |
| `prd.md` | orchestrator | Structured PRD template the PM fills before spawning the architect; read by architect and renderer |
| `renderer-design.md` | orchestrator | Renderer spawn prompt — converts PRD + design document + task DAG YAML + runbook to unified `design.html`; pure markdown, no MCP calls |
| `renderer-review.md` | orchestrator | Renderer spawn prompt — converts review markdown to `review.html`; references `file-detail-card.html` (Canvas-based) and `blast-radius-tree.html`; requires MCP calls (`show_pr_impact`, `get_file_context`) |
| `sharpened-request.md` | pm-orchestrator | PM-to-architect hand-off artifact with Problem, Direction, Scope Boundaries, Acceptance Criteria, and Not Doing sections |

## Spawn-Prompt Templates

Spawn-prompt templates are structurally distinct from artifact-output templates. They are read by the **orchestrator** (not agents) before `Agent()` calls:

| Template | Agent | Purpose |
|----------|-------|---------|
| `worker-prompt.md` | engineer (DAG worker) | DAG worker spawn prompt |
| `renderer-design.md` | renderer | Design document HTML renderer spawn prompt |
| `renderer-review.md` | renderer | Review dashboard HTML renderer spawn prompt |

**Reading protocol**: The orchestrator reads the template, fills `## Variables` placeholders, and passes the `## Prompt` section content to the `Agent()` call. See `principles/conventions/spawn-prompt-template-structure.md` for the full convention.

## Conventions
<!-- last-updated: 2026-03-22 -->

- Templates ensure downstream agents can reliably parse upstream output
- Never modify template structure without updating all consuming agents
- Templates use markdown with clear section headers and placeholder text
- Some templates now include optional evidence sections (`External Evidence`, `Evidence URLs`, `Verified Facts`, `Assumptions`) that downstream readers should preserve and tolerate when absent
