# Canon Skill

This directory is the Claude Code skill entry point for Canon. When a developer installs Canon as a Claude Code skill, this is the directory Claude Code reads to activate Canon's orchestrator identity and load its capabilities.

## How Canon Activates

Claude Code skills work by reading a `SKILL.md` file that defines the skill's persona, activation conditions, and linked references. Canon's `SKILL.md` establishes the orchestrator identity — it tells Claude Code to treat every project-related message as a Canon intent, classify it, and route it through the appropriate flow or specialist agent. The skill is designed to activate broadly: any mention of building, fixing, reviewing, or discussing the codebase should route through Canon.

## Slash Commands

The `commands/` directory contains user-facing slash commands that developers can invoke directly. These are utility commands for common Canon operations — initializing a workspace, checking principle compliance, running diagnostics, reviewing a PR, and managing principles. Each command is a short markdown file describing what it does and how to use it.

Commands are the human interface to Canon. They let developers trigger specific Canon capabilities without going through the full build pipeline.

## Reference Fragments

The `references/` directory contains reference documents that agents load on demand during execution. These are not injected wholesale — each agent loads only the fragments relevant to its role. The fragments cover:

- **Orchestrator protocol** — how the orchestrator follows the documented orchestration sequence and dispatches agents
- **Principle loading** — how and when agents load Canon principles for compliance checking
- **Workspace logging** — the protocol agents follow for logging activity to the workspace
- **Status protocol** — the defined status keywords (DONE, BLOCKED, NEEDS_CONTEXT, etc.) and when to use them
- **Context isolation** — how agents maintain fresh context and avoid cross-contamination between tasks
- **Security checklist** — security review criteria for the security agent
- **Tester report template** — output format guidance for the tester agent
- **Learner dimensions** — the analysis dimensions the learner agent covers when proposing principle improvements
- Other role-specific guidance documents

This design keeps each agent's context budget focused on what it actually needs, rather than loading all Canon documentation into every spawn.

## Evals

The `evals/` directory contains an evaluation suite for validating Canon's intent classification and flow routing. After making changes to flow definitions or agent instructions, run the evals to confirm that common user intents still route to the right agent and flow:

```
/canon:check
```

Evals are the test suite for Canon's orchestration behavior — they catch regressions in routing logic the same way unit tests catch regressions in application code.

## Relationship to CLAUDE.md

`SKILL.md` and `CLAUDE.md` serve different purposes. `SKILL.md` is read by Claude Code at installation time to set up the skill. The `.claude/CLAUDE.md` file in this directory is read by agents at runtime to understand the conventions for working within this part of the codebase. Both are necessary; neither duplicates the other.
