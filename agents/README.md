# Canon Agents

14 agent definitions for Canon's multi-agent build pipeline. Each file is a markdown document with YAML frontmatter (name, model, color, tools) followed by behavioral instructions. The orchestrator spawns agents as leaf workers during flow execution — agents do not spawn further agents.

## Agent Roster

| Agent | Role | Model | Color |
|-------|------|-------|-------|
| `canon-orchestrator` | Single entry point; classifies intent, drives flow state machine, spawns all other agents | opus | white |
| `canon-architect` | Designs technical approach; produces design decisions and task decomposition | opus | green |
| `canon-reviewer` | Reviews code against Canon engineering principles; two-stage: compliance then quality | opus | red |
| `canon-learner` | Analyzes patterns, drift data, and decision logs to suggest principle improvements | opus | blue |
| `canon-implementor` | Executes a single task plan; writes code and unit tests; commits atomically | sonnet | magenta |
| `canon-tester` | Writes integration tests and fills coverage gaps after implementation | sonnet | cyan |
| `canon-researcher` | Investigates one research dimension before planning; produces a findings document | sonnet | yellow |
| `canon-security` | Reviews code for vulnerabilities, unsafe patterns, and compliance issues | sonnet | red |
| `canon-scribe` | Post-implementation context sync; updates CLAUDE.md, context.md, CONVENTIONS.md | sonnet | cyan |
| `canon-fixer` | Fixes failing tests or principle violations identified by other agents | sonnet | yellow |
| `canon-shipper` | Synthesizes build artifacts into PR description and changelog; creates the PR | sonnet | green |
| `canon-writer` | Creates and edits Canon principles, conventions, and agent-rules | sonnet | blue |
| `canon-guide` | Read-only; answers questions, explains principles, presents project health dashboards | sonnet | cyan |
| `canon-inspector` | Analyzes completed build workspaces; produces cost, bottleneck, and failure reports | sonnet | cyan |

**Model tier rationale**: opus agents handle high-reasoning tasks — design, review, pattern analysis, and orchestration. sonnet agents handle execution tasks where speed and volume matter more than deliberation.

## Agent File Format

Every agent file follows this structure:

```markdown
---
name: canon-{role}
description: >-
  One to three sentence description of what this agent does and when
  it is spawned.
model: opus | sonnet
color: white | green | red | blue | magenta | cyan | yellow
tools:
  - Read
  - Write   # only if agent needs to produce artifacts
  - Edit    # only if agent modifies existing files
  - Bash
  - Glob
  - Grep
  - WebFetch  # only for researcher
  - Agent     # only for orchestrator
---

Behavioral instructions in plain markdown...
```

The `tools` list is enforced by the runtime — agents only have access to the tools listed in their frontmatter. Read-only agents (reviewer, researcher, security, guide, inspector, learner) do not receive `Write` or `Edit`.

## The Orchestrator

The orchestrator is special: **your Claude session IS the orchestrator**. It is not spawned as a subagent. When Canon is initialized in a project, the Claude session reads `agents/canon-orchestrator.md` and adopts that identity for the duration of the conversation.

The orchestrator's job is dispatching, not working:

1. Classify user intent (build, review, explore, question, etc.)
2. Call `load_flow` to get the flow state machine
3. Call `init_workspace` to create or resume a workspace
4. For each state: call `check_convergence` → `update_board(enter_state)` → `get_spawn_prompt` → spawn specialist agent via the `Agent` tool → call `report_result` → advance to next state
5. On terminal state: call `update_board(complete_flow)`

The orchestrator never writes code, produces reviews, runs security scans, or authors any task artifacts. If it catches itself doing task work, that is a protocol violation.

## Agent Permissions

Context isolation is enforced structurally — agents receive only what they need.

### Reviewer: Cold Review

The reviewer receives only:
- The diff or files to review
- Matched Canon principles (full body)
- A brief description of what the change is supposed to do

It does NOT receive session history, design documents, research findings, or implementation plans. This ensures reviews are independent assessments, not rubber stamps on decisions already made.

### Implementor: Fresh Context Per Task

Each implementor instance receives only:
- Its own task plan file
- Relevant Canon principles for the files it will touch
- The workspace `context.md` (shared architect decisions)
- CLAUDE.md

It does NOT read other tasks' plans, summaries, or session history. One implementor per task, one commit per implementor. This prevents context bleed between parallel tasks and keeps each agent's working set small.

### Researcher: Scoped to One Dimension

Multiple researchers run in parallel, each investigating a single dimension (e.g., "existing patterns", "risk surface", "external API constraints"). Each researcher produces one findings document. Researchers do not read each other's output — the architect merges findings after all researchers complete.

### Summary of Access Rules

| Agent | Reads | Cannot Read |
|-------|-------|------------|
| Orchestrator | Everything | — |
| Architect | Research findings, principles, CLAUDE.md | — |
| Implementor | Own plan, principles, workspace context.md | Other task plans, other summaries |
| Reviewer | Diff/files, principles, brief description | Research, design docs, plans |
| Tester | Implementation summaries, workspace context.md | — |
| Researcher | Codebase files, web (WebFetch) | Other researchers' findings |
| Fixer | Test report or review checklist, relevant source files | — |
| Security | Implemented code | — |
| Scribe | Git diff, implementation summaries | — |
| Shipper | All build artifacts | — |

## Output Templates

Agents must follow structured output templates from `templates/`. This is enforced by the `agent-template-required` rule — agents read the template before producing any output. Templates ensure downstream agents can reliably parse upstream artifacts.

| Template | Produced By | Consumed By |
|----------|-------------|-------------|
| `research-finding.md` | researcher | architect |
| `design-decision.md` | architect | implementor |
| `implementation-log.md` | implementor, fixer | tester, reviewer, scribe, shipper |
| `review-checklist.md` | reviewer | shipper |
| `session-context.md` | architect | implementor |
| `security-assessment.md` | security | shipper |
| `context-sync-report.md` | scribe | shipper |
| `test-report.md` | tester | shipper |
| `wave-briefing.md` | orchestrator | implementor |
| `claudemd-template.md` | scribe | (project root CLAUDE.md) |

Templates use plain markdown with clear section headers and placeholder text. Never modify template structure without updating all agents that consume the template.

## Graph-Aware Agents

Three agents use the dependency graph (`codebase_graph` MCP tool) to make better decisions:

**Reviewer** — The `get_pr_review_data` tool provides a priority-scored list of files based on their position in the dependency graph. Files with many dependents get reviewed more carefully. The reviewer uses this to focus attention on high-impact changes and detect ripple effects.

**Fixer** — When fixing principle violations, the fixer reads the dependency graph to understand which files import the file being changed. This prevents fixes from breaking callsites that depend on the original interface.

**Architect** — During task decomposition, the architect uses graph data to detect shared dependencies between proposed tasks. Tasks that touch the same high-centrality files get serialized (wave ordering) rather than parallelized, avoiding merge conflicts.

## Agent Workspaces

Agents share context through task-scoped workspaces stored in `.canon/workspaces/`. Each workspace is tied to a branch and a build session.

### Directory Structure

```
.canon/workspaces/{branch-slug}/
├── board.json          # State machine: current state, completed states, wave progress
├── board.json.bak      # Previous board snapshot (rollback target)
├── session.json        # Session metadata: flow name, variables, timestamps
├── context.md          # Architect's living context doc — key decisions and patterns
├── log.jsonl           # Append-only activity log: all agent start/complete entries
├── research/           # Researcher output (one .md file per dimension)
├── decisions/          # Architect decision records (referenced by implementors)
├── notes/              # Ephemeral scratch notes (not consumed by downstream agents)
├── reviews/            # Reviewer output (review-checklist artifacts)
└── plans/
    └── {task-slug}/
        ├── PLAN.md                 # Task plan (implementor's primary input)
        ├── CONVENTIONS.md          # Task-level conventions (overrides project)
        ├── *-SUMMARY.md            # Implementor or fixer summary
        ├── TEST-REPORT.md          # Tester output
        └── FIX-SUMMARY.md          # Fix-mode fixer output
```

### Workspace Lifecycle

**Create**: The orchestrator calls `init_workspace(flow_name, task_description, branch)` at the start of every build. If a workspace already exists for the branch, it is resumed rather than overwritten — the board state is preserved and the orchestrator picks up from the last completed state.

**During build**: Each agent appends to `log.jsonl` on start and complete. The orchestrator calls `update_board` to mutate state transitions. Artifacts accumulate in `research/`, `plans/`, and `reviews/` as agents complete.

**Archive**: After a successful ship, the workspace is retained for inspection. The `canon-inspector` agent can read `board.json` and `log.jsonl` post-build to produce cost breakdowns, bottleneck analysis, and failure reports.

**Delete**: Workspaces are not automatically deleted. They can be removed manually or by a future cleanup command once the branch is merged and closed.
