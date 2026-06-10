# Canon Templates — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Structured output templates that agents must follow for consistent, parseable artifacts. Enforced by the `agent-template-required` rule — agents must read the template before producing output.

## Architecture
<!-- last-updated: 2026-06-09 (docs/adr/TEMPLATE.md added — durable ADR promotion template, distinct from ephemeral design-decision.md; see ADR-0001) -->

Each template is a markdown file with placeholder sections that agents fill in.

**Available templates:**

| Template | Used By | Purpose |
|----------|---------|---------|
| `claudemd-template.md` | scribe | CLAUDE.md structure |
| `design-decision.md` | architect | Architecture decisions with tradeoffs — ephemeral record written to `${WORKSPACE}/decisions/` mid-build; consumed by engineer |

**ADR template coexistence (ADR-0001):** `design-decision.md` and `docs/adr/TEMPLATE.md` serve different lifecycles. `design-decision.md` is ephemeral — the architect writes it to `${WORKSPACE}/decisions/` during a build and it is consumed mid-build. `docs/adr/TEMPLATE.md` is the durable tracked promotion template written only when the conjunctive 3-condition ADR gate passes (decision affects public contract, high reversal cost, and stakeholder alignment required). Durable ADRs land in `docs/adr/NNNN-slug.md` in the worktree and are committed to the repo.
| `summary.md` | engineer | Task implementation summary — required `#### Criteria Coverage` table maps every task-plan acceptance criterion to a disposition (`covered`, `descoped`, `partial`); reviewer checks this in Stage 3 compliance cross-check |
| `review.md` | reviewer | Code review output with violations |
| `security-assessment.md` | security | Vulnerability findings and remediation |
| `session-context.md` | orchestrator | Session-level context and blockers |
| `test-report.md` | tester | Test coverage and results |
| `context-sync.md` | scribe | Cross-iteration context sync |
| `design-document.md` | architect | Technical design with Canon alignment |
| `task-plan.md` | architect | Atomic task plan for engineers — required `### Brief Coverage` table maps every runbook requirement to a task element with disposition (`covered`, `descoped`, `partial`); missing or empty table is a plan defect that blocks progression |
| `plan-index.md` | architect | Index of all task plans for a build |
| `runbook.md` | architect | Runbook step sequence for orchestrator execution |
| `pr-description.md` | shipper | PR description from build artifacts |
| `chat-brief.md` | chat | Structured brief for build handoff |
| `prd.md` | orchestrator | Structured PRD template the PM fills before spawning the architect; read by architect and renderer |
| `renderer-design.md` | orchestrator | Renderer spawn prompt — converts PRD + design document + task DAG YAML + runbook to unified `design.html`; pure markdown, no MCP calls |
| `renderer-review.md` | orchestrator | Renderer spawn prompt — converts review markdown to `review.html`; file cards are `<details>`-expandable; includes Canvas dependency subgraph in Graph Context; delegates force-directed layout to shared `force-graph.html` snippet via `renderForceGraph(...)`; references `file-detail-card.html` (Canvas-based) and `blast-radius-tree.html`; requires MCP calls (`show_pr_impact`, `get_file_context`); **Step 9** (MANDATORY): renderer must run 5 grep assertions against the written `review.html` (card count, snippet CSS, `drawFileGraph(` once, `renderForceGraph(` once [conditional on `showSubgraph`], design token defined) and loop repair+recheck until all pass before returning |
| `renderer-codebase-graph.md` | orchestrator | Renderer spawn prompt — converts `codebase_graph` MCP data into standalone `codebase-graph.html`; delegates force-directed layout to shared `force-graph.html` snippet via `renderForceGraph(...)`; click-to-inspect side panel, DIFF_BASE filtering kept in template; requires MCP call (`codebase_graph`) |
| `renderer-file-context.md` | orchestrator | Renderer spawn prompt — converts `get_file_context` MCP data into standalone `file-context.html`; requires MCP call (`get_file_context`) |
| `sharpened-request.md` | pm-orchestrator | PM-to-architect hand-off artifact with Problem, Direction, Scope Boundaries, Acceptance Criteria, and Not Doing sections |

## Spawn-Prompt Templates

Spawn-prompt templates are structurally distinct from artifact-output templates. They are read by the **orchestrator** (not agents) before `Agent()` calls:

| Template | Agent | Purpose |
|----------|-------|---------|
| `worker-prompt.md` | engineer (DAG worker) | DAG worker spawn prompt |
| `renderer-design.md` | renderer | Design document HTML renderer spawn prompt |
| `renderer-review.md` | renderer | Review dashboard HTML renderer spawn prompt |

**Reading protocol**: The orchestrator reads the template, fills `## Variables` placeholders, and passes the `## Prompt` section content to the `Agent()` call. See `principles/conventions/spawn-prompt-template-structure.md` for the full convention.

## Renderer Helper Convention <!-- last-updated: 2026-06-06 -->

All `renderer-*.md` templates source `escapeHtml` and `markdownToHtml` from `mcp-server/src/ui/snippets/DESIGN-SYSTEM.md` **Section E** — never re-inline these definitions. Each template instructs the renderer agent to copy the Section E definitions verbatim into its build-time rendering script.

**Runtime page scripts** — JavaScript emitted verbatim into the page and executed by the browser (e.g., the Canvas force-directed IIFE) — live in a dedicated snippet file under `mcp-server/src/ui/snippets/` (reference: `force-graph.html`), emitted via `readSnippet`.

**Discriminator**: function body appears inside a `<script>`/Canvas IIFE in the emitted HTML → runtime → snippet file. Function's return value is interpolated into the HTML string during composition → build-time → DESIGN-SYSTEM.md Section E. Full convention: `principles/conventions/shared-renderer-helper-placement.md`.

## Conventions
<!-- last-updated: 2026-06-06 -->

- Templates ensure downstream agents can reliably parse upstream output
- Never modify template structure without updating all consuming agents
- Templates use markdown with clear section headers and placeholder text
- Some templates now include optional evidence sections (`External Evidence`, `Evidence URLs`, `Verified Facts`, `Assumptions`) that downstream readers should preserve and tolerate when absent
- **Template filenames must match their output artifact stem in lowercase-kebab form.** A template that produces `CONTEXT-SYNC.md` is named `context-sync.md`; one that produces `REVIEW.md` is named `review.md`; one that produces `*-SUMMARY.md` is named `summary.md`. This lets the orchestrator derive the output filename from the template name mechanically. (sug_KKKK1 Fix C)
- Builds that change `renderer-*.md` or renderer-consumed snippets (`mcp-server/src/ui/snippets/*.html` or `mcp-server/src/ui/snippets/DESIGN-SYSTEM.md`) must dogfood-render the build's own review.html through the changed template before the review step closes (see root CLAUDE.md → Post-Step Effects → After reviewer).
