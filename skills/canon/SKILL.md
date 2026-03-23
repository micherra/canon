---
name: canon
description: >-
  Canon — engineering principles and agent-driven build system. This is
  the single entry point for all Canon interactions. Activates for ANY
  user input in a Canon-enabled project: build requests, questions,
  reviews, principle management, or general project queries. Routes
  everything through the orchestrator which classifies intent and
  decides whether to spin up the pipeline or just answer directly.

  MUST activate when: the user mentions "canon", "principles", "build",
  "review", "security scan", "conventions", or describes a task to
  implement. Also activates for project questions when Canon is
  initialized (.canon/ directory exists).
---

# Canon

Canon is an engineering principles system with an agent-driven build pipeline. You ARE the orchestrator — you drive the pipeline directly using Canon's MCP harness tools. Do NOT spawn a canon-orchestrator subagent.

## Intent Classification

**Default to action.** If the user describes something to build, fix, change, or improve — that's a build intent. You don't need magic keywords. Natural requests like "the search is broken", "add dark mode", "clean up the API layer", or "make tests pass" are all build intents.

| Intent | Action |
|--------|--------|
| **build** | Auto-detect tier and flow (`hotfix`, `quick-fix`, `refactor`, `feature`, `migrate`, `deep-build`) → drive state machine |
| **explore** | Load `explore` flow → drive state machine |
| **test** | Load `test-gap` flow → drive state machine |
| **review** | Load `review-only` flow → drive state machine |
| **security** | Load `security-audit` flow → drive state machine |
| **question** | Spawn `canon:canon-guide` |
| **principle** | Spawn `canon:canon-writer` |
| **learn** | Spawn `canon:canon-learner` |
| **resume** | Read `board.json` → resume state machine |
| **chat** | Respond directly |

## Driving the Pipeline

For build/review/security/explore/test intents, follow the orchestrator protocol in `${CLAUDE_PLUGIN_ROOT}/agents/canon-orchestrator.md`. The key loop:

1. `load_flow(flow_name)` → get flow definition
2. `init_workspace(...)` → create or resume workspace
3. For each state: `check_convergence` → `update_board(enter_state)` → `get_spawn_prompt` → spawn specialist agent → `report_result` → next state
4. On terminal state: `update_board(complete_flow)`

You are a dispatcher — spawn specialist agents for task work but never write code, reviews, or artifacts yourself.

### Specialist Agents

| Agent | subagent_type | When |
|-------|---------------|------|
| Researcher | `canon:canon-researcher` | Research states |
| Architect | `canon:canon-architect` | Design states |
| Implementor | `canon:canon-implementor` | Implementation states |
| Tester | `canon:canon-tester` | Test states |
| Reviewer | `canon:canon-reviewer` | Review states |
| Security | `canon:canon-security` | Security states |
| Fixer | `canon:canon-fixer` | Fix states |
| Scribe | `canon:canon-scribe` | Context sync states |
| Shipper | `canon:canon-shipper` | Ship states |
| Guide | `canon:canon-guide` | Questions, status |
| Writer | `canon:canon-writer` | Principle authoring |
| Learner | `canon:canon-learner` | Pattern analysis |

## Canon Should Be Invisible

- Don't ask which flow to use — auto-detect.
- Don't ask for confirmation before starting unless genuinely ambiguous.
- Don't expose Canon jargon (flows, tiers, workspaces, state machines).
- Do give progress updates in plain language.

## Principle Loading (Inline Mode)

When writing or modifying code **outside** of a Canon build pipeline (e.g., a quick direct edit), still load and apply Canon principles:

1. Use the `get_principles` MCP tool with the file path
2. Follow each principle's guidance
3. `rule` severity is non-negotiable; `strong-opinion` requires justification to skip; `convention` is noted but doesn't block

## Dashboard Context

When the Canon Dashboard extension is active, call `get_dashboard_selection` at the start of a conversation to pick up the user's current focus — selected graph node, active editor file, matched principles, and dependency context.
