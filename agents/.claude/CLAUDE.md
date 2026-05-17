# Canon Agents — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-22 -->
Agent definitions for Canon's multi-agent build pipeline. Each markdown file defines a specialized Claude agent with its role, tools, permissions, and behavioral rules.

## Architecture
<!-- last-updated: 2026-04-22 -->

Each agent file uses YAML frontmatter (`name`, `description`, `model`, `color`, `maxTurns`, `permissionMode`, `memory`, `skills`, `tools`) followed by markdown instructions. Agents are spawned by the orchestrator during flow execution.

**Agent roster (9):**

| Agent | Role | Model |
|-------|------|-------|
| `architect` | First technical step: researches codebase, assesses triviality, designs solutions, produces runbooks and task plans | opus |
| `engineer` | Executes code-writing work in implementation mode (per a plan) or fix mode (targeted bug or violation fixes) | sonnet |
| `learner` | Analyzes patterns; suggests principle improvements | sonnet |
| `reviewer` | Reviews code for principle compliance | opus |
| `scribe` | Updates CLAUDE.md, context.md, CONVENTIONS.md post-implementation | sonnet |
| `security` | Security assessments on implemented code | opus |
| `shipper` | Handles final shipping decisions | sonnet |
| `tester` | Writes integration tests; fills coverage gaps | sonnet |
| `writer` | Creates and edits Canon principles and agent-rules | sonnet |

## Conventions
<!-- last-updated: 2026-04-29 -->

- Each agent has a declarative `permissionMode` enforced by Claude Code:
  - **`plan`** — truly read-only. No `Write` / `Edit` / `Bash`-to-modify AND no MCP `write_*` / `update_*` tools. Currently unused (the legacy planner was the only agent on this mode).
  - **`acceptEdits`** — auto-approves file edits and common filesystem commands scoped to the working directory. For agents that produce artifacts via MCP write tools (`architect` → `write_plan_index` / `write_design_brief` / `update_board`; `reviewer` → `write_review`; `tester` → `write_test_report`; `learner` → writes to `.canon/learning.jsonl` and `.canon/proposed-learnings/`; `shipper` → PR description; `writer` → principle files) or that write file artifacts directly (`engineer`, `scribe`, `security`).
  - **Why not all `plan` for read-only roles?** Claude Code's `plan` mode blocks ALL write tools including MCP `write_*` — per [permission-modes](https://code.claude.com/docs/en/permission-modes.md). So the subset that genuinely can't write anything (no MCP write tools) stays on `plan`; everyone else is `acceptEdits`. Each agent's `tools:` list is the real allowlist.
- Each agent has a `maxTurns` budget appropriate to its role. A turn is one assistant message with tool calls; text-only responses don't consume a turn. Parallel tool calls in one message = 1 turn.
- Agents receive fresh context per spawn (no carryover between invocations).
- Agent output must follow templates declared in `templates:` frontmatter (see `agent-template-required` rule). Templates preload like rules/references/primers; no runtime Read is required.
- **Four dedicated preload fields** — each lives in its own frontmatter list where the field name *is* the namespace:
  - `rules:` — bare names resolving to `rules/<name>.md` (imperative agent-behavior rules).
  - `references:` — bare names resolving to `references/<name>.md` (protocol fragments, checklists).
  - `primers:` — bare names resolving to `primers/<name>.md` (domain context).
  - `templates:` — bare names resolving to `templates/<name>.md` (required output shapes).

  The Canon MCP tool `resolve_agent_skills` reads all four fields and returns the concatenated content; the lead injects it into the spawn prompt before calling `Agent`. The native `skills:` field is reserved for real Claude Code native skills (per-directory `SKILL.md` wrappers) and is untouched by Canon's resolver.
- Agents log activity per `workspace-logging.md` protocol.
- `engineer` has direct access to `mcp__canon__write_implementation_summary` for implementation summaries.
- `engineer` documents JUSTIFIED_DEVIATIONs in the Canon Compliance section of the summary for auditing purposes.
- `engineer` (verify mode): before reporting any build or test failure as BLOCKING, must verify whether the failure exists on the base branch. Pre-existing failures are noted as PRE-EXISTING and do not block.
- `reviewer` writes its review artifact to `${WORKSPACE}/reviews/REVIEW.md` (exact path). The orchestrator must inject `WORKSPACE={workspace_path}` (workspace root, not worktree path) into the reviewer's spawn prompt to ensure correct artifact placement.
- Agents with `memory: project` (engineer, architect, scribe, learner, tester) persist agent memory across sessions; others do not.
