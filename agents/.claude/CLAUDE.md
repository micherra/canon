# Canon Agents — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-22 -->
Agent definitions for Canon's multi-agent build pipeline. Each markdown file defines a specialized Claude agent with its role, tools, permissions, and behavioral rules.

## Architecture
<!-- last-updated: 2026-06-26 -->

Each agent file uses YAML frontmatter (`name`, `description`, `model`, `color`, `maxTurns`, `permissionMode`, `memory`, `skills`, `tools`) followed by markdown instructions. Agents are spawned by the orchestrator during flow execution.

**Agent roster (10):**

| Agent | Role | Model |
|-------|------|-------|
| `architect` | Technical planning for non-trivial builds: researches codebase, designs solutions, produces runbooks and task plans | opus |
| `engineer` | Executes code-writing work in implementation mode (per a plan) or fix mode (targeted bug or violation fixes) | sonnet |
| `evaluator` | Lightweight quality gate — interprets structural signals against acceptance criteria; returns PASS/FAIL verdict | haiku |
| `learner` | Analyzes patterns; suggests principle improvements | sonnet |
| `reviewer` | Reviews code for principle compliance | opus |
| `scribe` | Updates CLAUDE.md, context.md, CONVENTIONS.md post-implementation; checks touched directories for missing CLAUDE.md (Step 2b, doc-gap detection) and reports gaps informational-only in CONTEXT-SYNC.md | sonnet |
| `security` | Security assessments on implemented code | opus |
| `shipper` | Handles final shipping decisions | sonnet |
| `tester` | Writes integration tests; fills coverage gaps | sonnet |
| `writer` | Creates and edits Canon principles and agent-rules | sonnet |

## Artifact Inventory
<!-- canon:inventory:start class=agents -->
| artifact | summary |
|---|---|
| architect.md | Technical planning for non-trivial builds. Performs codebase research, designs technical approach, produces a runbook, and breaks the design into atomic task plans. Does NOT write code. |
| engineer.md | Executes code-writing work. Operates in two modes: implementation (new code per a task plan) or fix (targeted bug or violation fixes). Mode is selected by spawn prompt context. Spawned by the lead orchestrator. |
| evaluator.md | Lightweight quality gate agent that interprets structural signals (pattern findings, scope overlap, diff stats) against acceptance criteria and implementation summary. Returns a structured PASS/FAIL verdict. Runs on Haiku for cost and speed. |
| learner.md | Analyzes codebase patterns, review history, build execution data, and conventions to suggest improvements to Canon principles. Produces a structured learning report. Spawned by the lead orchestrator. |
| reviewer.md | Reviews code changes against Canon engineering principles. Six-stage evaluation: principle compliance, code quality, compliance cross-check, drift-from-plan, acceptance criteria verification, and cross-requirement consistency. Spawned by the build orchestrator, Canon intake, pr-review command, or other agents. |
| scribe.md | Post-implementation context sync agent. Reads git diffs and engineer summaries to update CLAUDE.md, context.md, and CONVENTIONS.md when contract-level changes occur. Strictly a documenter — never proposes new principles. |
| security.md | Reviews code for security vulnerabilities, unsafe patterns, and compliance issues. Produces a security assessment with findings ranked by severity. |
| shipper.md | Post-build delivery agent. Synthesizes build artifacts (summaries, test reports, review verdicts, design docs) into a PR description and creates the PR. Spawned by the orchestrator after the review/fix loop completes. |
| tester.md | Writes integration tests and fills coverage gaps for code produced by engineer agents. Handles cross-task integration, end-to-end flows, and missed coverage. Spawned by the build orchestrator after implementation. |
| writer.md | Creates, edits, and forks Canon principles, conventions, and agent-rules. Focuses on behavioral constraints and uses the principle template as source of truth. Handles interview, examples, conflict detection, save, and validation. Spawned by Canon intake or via /canon:edit-principle. |
<!-- canon:inventory:end -->

## Conventions
<!-- last-updated: 2026-06-09 -->

- **Harness tool grants (as of 2026-06-09):** `LSP` (navigation-only — `findReferences`/`goToDefinition`/etc., no `getDiagnostics`) granted to `reviewer`, `engineer`, `architect`. `WebSearch` granted to `security`, `architect`, `learner`. `WebFetch` granted to `writer` (others already had it or intentionally omitted). `PushNotification` is an orchestrator-side call (NOT an agent grant) fired at plan-approval, review-verdict, and build-complete gates. Requires `typescript-language-server` installed globally for LSP to return results.
- Each agent has a declarative `permissionMode` enforced by Claude Code:
  - **`plan`** — truly read-only. No `Write` / `Edit` / `Bash`-to-modify AND no MCP `write_*` / `update_*` tools. Currently unused by any live agent.
  - **`acceptEdits`** — auto-approves file edits and common filesystem commands scoped to the working directory. For agents that produce artifacts via MCP write tools (`architect` → `write_plan_index`; `reviewer` → `write_review`; `tester` → `write_test_report`; `learner` → writes to `.canon/learning.jsonl` and `.canon/proposed-learnings/`; `shipper` → PR description; `writer` → principle files) or that write file artifacts directly (`engineer`, `scribe`, `security`).
  - **Why not all `plan` for read-only roles?** Claude Code's `plan` mode blocks ALL write tools including MCP `write_*` — per [permission-modes](https://code.claude.com/docs/en/permission-modes.md). So the subset that genuinely can't write anything (no MCP write tools) stays on `plan`; everyone else is `acceptEdits`. Each agent's `tools:` list is the real allowlist.
- Each agent has a `maxTurns` budget appropriate to its role. A turn is one assistant message with tool calls; text-only responses don't consume a turn. Parallel tool calls in one message = 1 turn.
- Agents receive fresh context per spawn (no carryover between invocations).
- Agent output must follow templates declared in `templates:` frontmatter (see `agent-template-required` rule). Templates preload like rules/references/primers; no runtime Read is required.
- **Four dedicated preload fields** — each lives in its own frontmatter list where the field name *is* the namespace:
  - `rules:` — bare names resolving to `rules/<name>.md` (imperative agent-behavior rules).
  - `references:` — bare names resolving to `references/<name>.md` (protocol fragments, checklists).
  - `primers:` — bare names resolving to `primers/<name>.md` (domain context).
  - `templates:` — bare names resolving to `templates/<name>.md` (required output shapes).

  The Canon MCP tool `resolve_agent_skills` reads all four fields and returns the concatenated content; the lead injects it into the spawn prompt before calling `Agent`. The native `skills:` field is reserved for real Claude Code native skills (per-directory `SKILL.md` wrappers) and is untouched by Canon's resolver. `architect`, `learner`, and `tester` have `Skill` in their `tools:` allowlist (enabling `/deep-research` and `/verify` stock skill invocation); `"Skill"` is also granted in `.claude/settings.json` `permissions.allow`.
- Agents log activity per `workspace-logging.md` protocol.
- `engineer` has direct access to `mcp__canon__write_implementation_summary` for implementation summaries.
- `engineer` documents JUSTIFIED_DEVIATIONs in the Canon Compliance section of the summary for auditing purposes.
- `engineer` (verify mode): before reporting any build or test failure as BLOCKING, must verify whether the failure exists on the base branch. Pre-existing failures are noted as PRE-EXISTING and do not block.
- `reviewer` writes its review artifact to `${WORKSPACE}/reviews/REVIEW.md` (exact path). The orchestrator must inject `WORKSPACE={workspace_path}` (workspace root, not worktree path) into the reviewer's spawn prompt to ensure correct artifact placement.
- `reviewer` preloads `references/codex-defect-checklist.md` (via `references:` frontmatter) — adds Stage 2 grep checks and Stage 6 judgment prompts for the top-7 Codex recurring defect classes; all grep checks are advisory→WARNING, never BLOCKING.
- Agents with `memory: project` (engineer, architect, scribe, learner, tester) persist agent memory across sessions; others do not.
- **`reviewer` Measured-Step Module Contracts (topology C, added 2026-07-06):** `reviewer.md` documents its six stages as ten addressable modules (`M0`…`MV`, each a `(reads, writes, barrier)` tuple) in a new `## Measured-Step Module Contracts` section. At topology C this is a documented contract and metrics obligation only — the reviewer still runs all modules in one agent window (honor-system cold barrier, unchanged); a future topology-A/B escalation would promote the barrier column to a structurally-enforced per-module spawn boundary. The reviewer calls `record_agent_metrics({ workspace, state_id, stage, tool_calls, turns })` at each module boundary M1–M6 (`stage` ∈ `"1"|"1.5"|"2"|"3"|"4"|"5"|"6"`), additive to the single final call `agent-metrics-before-return` already requires.
- **Per-agent eval suites (new pattern, added 2026-07-06):** `agents/<name>/evals/` is a per-agent eval suite directory (`eval-set.json` + `fixtures/` + an optional `holistic/eval-set.json`), sibling to the agent's `.md` definition. Currently only `agents/reviewer/evals/` exists. `evaluate_candidate` resolves an agent-def `target_path` (`agents/<name>.md`) to its suite via `resolveAgentEvalRoot` and runs `agents/<name>/evals/run-agent-evals.sh` instead of the global `skills/canon/evals/` suite; falls back to the global runner when no per-agent suite exists. See `mcp-server/src/features/evolution/.claude/CLAUDE.md`.
