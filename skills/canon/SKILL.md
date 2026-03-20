---
name: canon
description: >-
  Canon — engineering principles and agent-driven build system. This is
  the single entry point for all Canon interactions. Activates for ANY
  user input in a Canon-enabled project: build requests, questions,
  reviews, principle management, or general project queries. Routes
  everything through the canon-orchestrator which classifies intent and
  decides whether to spin up the pipeline or just answer directly.

  MUST activate when: the user mentions "canon", "principles", "build",
  "review", "security scan", "conventions", or describes a task to
  implement. Also activates for project questions when Canon is
  initialized (.canon/ directory exists).
---

# Canon

Canon is an engineering principles system with an agent-driven build pipeline. All user interactions are routed through the **canon-orchestrator**, which classifies intent and decides the appropriate response.

## How It Works

The orchestrator handles everything:

- **Build tasks** ("create a dashboard", "add auth") → triage, tier detection, full agent pipeline
- **Reviews** ("review my changes") → review-only flow
- **Security** ("scan for vulnerabilities") → security-audit flow
- **Questions** ("how does the order service work?") → reads codebase and answers directly
- **Principles** ("create a rule about logging") → spawns canon-writer
- **Learning** ("what patterns should we codify?") → spawns canon-learner
- **Resume** ("continue where we left off") → resumes from board.json

## Dashboard Context

When the Canon Dashboard extension is active, call `get_dashboard_selection` at the start of a conversation or task to pick up the user's current focus. It returns:
- The **selected node** from the graph (the file the user clicked on)
- The **active editor file** the user is viewing
- **Matched principles** for the active file (summary-only, top 3)
- **Dependencies and dependents** from the codebase graph

This gives you immediate context about what the user is looking at without them having to explain it.

## Activation

When Canon is initialized in a project (`.canon/` directory exists), spawn the **canon-intake** agent with the user's input. Intake classifies intent and either handles it directly (questions, status) or hands off to the orchestrator (builds, reviews, security scans).

```
Agent: canon-intake
Prompt: {user's message}
```

The intake definition is at `${CLAUDE_PLUGIN_ROOT}/agents/canon-intake.md`.
The orchestrator definition is at `${CLAUDE_PLUGIN_ROOT}/agents/canon-orchestrator.md`.

## Principle Loading (Inline Mode)

When you are writing or modifying code **outside** of a Canon build pipeline (e.g., the user asks you to edit a file directly without going through `/canon`), you must still load and apply Canon principles:

1. Use the `get_principles` MCP tool with the file path you're working on
2. Follow each loaded principle's guidance
3. `rule` severity is non-negotiable; `strong-opinion` requires justification to skip; `convention` is noted but doesn't block
4. After generating code, self-review against loaded principles before presenting

This inline mode ensures principles are always applied, even for quick edits that don't warrant the full pipeline.

## Dashboard Context

When the Canon Dashboard extension is active, call `get_dashboard_selection` at the start of a conversation or task to pick up the user's current focus.

## Principle Format Reference

See `${CLAUDE_PLUGIN_ROOT}/skills/canon/references/principle-format.md` for the full principle file schema.
