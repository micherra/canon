# Canon Templates — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Structured output templates that agents must follow for consistent, parseable artifacts. Enforced by the `agent-template-required` rule — agents must read the template before producing output.

## Architecture
<!-- last-updated: 2026-06-06 (renderer-review.md: mandatory Step 9 structural self-check added; renderer-review.md and renderer-codebase-graph.md delegate force graph to shared force-graph.html snippet) -->

Each template is a markdown file with placeholder sections that agents fill in.

**Available templates:**

| Template | Used By | Purpose |
|----------|---------|---------|
| `claudemd-template.md` | scribe | CLAUDE.md structure |
| `design-decision.md` | architect | Architecture decisions with tradeoffs |
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

## Artifact Inventory
<!-- canon:inventory:start class=templates -->
| artifact | summary |
|---|---|
| chat-brief.md | Structured brief from chat discussion for build handoff |
| claudemd-template.md | Canonical structure for CLAUDE.md files managed by the scribe. Defines the sections the scribe maintains and the rules for editing them. Projects adopt this structure incrementally — the scribe adds sections as needed, never restructures the whole file at once. |
| context-sync.md | Standardized output for the scribe agent. Records which files were classified, which documents were updated, and freshness stamps. |
| design-decision.md | Structured format for recording architectural and design decisions |
| design-document.md | Structured format for design documents with North Star section |
| domain-primer.md |  |
| loop-definition.md | Authoring template for Loop-as-Artifact definitions. Drop a filled copy at loops/<id>.md to register a loop. The loops/ directory IS the registry — dropping a file registers the loop; it does NOT start it. Only the orchestrator starts loops by calling CronCreate at a named lifecycle moment. |
| plan-index.md | Index of all task plans for a build |
| planning-brief.md | DEPRECATED (2026-05-17). Was produced by the planner agent. The architect's DESIGN.md now absorbs the gating function (requirements, alternatives, value assessment). Kept for backward compatibility with existing workspace artifacts. |
| pr-description.md | PR description synthesized from build artifacts |
| prd.md | Structured PRD template the PM fills before spawning the architect |
| renderer-codebase-graph.md | Renderer spawn prompt for converting codebase_graph MCP data into a standalone codebase-graph.html with force-directed layout, click-to-inspect panel, and DIFF_BASE filtering |
| renderer-design.md | Renderer spawn prompt for converting the PRD + architect design document + task DAG into a unified design.html |
| renderer-file-context.md | Renderer spawn prompt for converting get_file_context MCP data into a standalone file-context.html |
| renderer-review.md | Renderer spawn prompt for converting the review markdown + live MCP data into review.html |
| review.md | Structured format for review outputs |
| routine.md | Schema-as-template for Canon routine artifacts — fill this in when authoring a new routine via the writer |
| runbook.md | Synthesized runbook produced by the architect agent (canon:synthesize skill). Defines the ordered step sequence that the orchestrator executes. |
| security-assessment.md | Standardized output for the security agent. Records vulnerability findings ranked by severity, passed checks, and blocking status. |
| session-context.md | Living shared context document for the workspace |
| sharpened-request.md | Lightweight PM-to-architect hand-off artifact. Produced by the PM's refine skill after sharpening a build request. Contains the problem, direction, scope boundaries, acceptance criteria, and exclusions. |
| summary.md | Structured format for implementor task summaries |
| task-dag.md | DAG schema for parallel task execution in multi-task builds |
| task-plan.md | Atomic task plan for implementor agents |
| test-report.md | Structured format for tester outputs |
| worker-prompt.md | Generic pull-loop prompt for Canon DAG worker agents |
<!-- canon:inventory:end -->

## Conventions
<!-- last-updated: 2026-06-06 -->

- Templates ensure downstream agents can reliably parse upstream output
- Never modify template structure without updating all consuming agents
- Templates use markdown with clear section headers and placeholder text
- Some templates now include optional evidence sections (`External Evidence`, `Evidence URLs`, `Verified Facts`, `Assumptions`) that downstream readers should preserve and tolerate when absent
- **Template filenames must match their output artifact stem in lowercase-kebab form.** A template that produces `CONTEXT-SYNC.md` is named `context-sync.md`; one that produces `REVIEW.md` is named `review.md`; one that produces `*-SUMMARY.md` is named `summary.md`. This lets the orchestrator derive the output filename from the template name mechanically. (sug_KKKK1 Fix C)
- Builds that change `renderer-*.md` or renderer-consumed snippets (`mcp-server/src/ui/snippets/*.html` or `mcp-server/src/ui/snippets/DESIGN-SYSTEM.md`) must dogfood-render the build's own review.html through the changed template before the review step closes (see root CLAUDE.md → Post-Step Effects → After reviewer).
