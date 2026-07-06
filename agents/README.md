# Canon Agents

This directory contains the specialist agent definitions that Canon uses to execute its multi-agent build pipeline. Each agent is a markdown file with YAML frontmatter describing its identity, model selection, tools, and detailed behavioral instructions.

## What Agents Are

In Canon, an "agent" is a specialist with a narrow mandate. Rather than one all-knowing AI handling every task, Canon decomposes work into distinct roles — researching, designing, implementing, reviewing, testing — and spawns a fresh agent instance for each. This isolation keeps context small, reduces error propagation, and lets each specialist be tuned precisely for its job.

The orchestrator reads these definition files when spawning agents and feeds the contents into the agent's context alongside the relevant task plan and principles.

## The Agent Roster

Canon ships with ten specialists, covering the full software development lifecycle:

- **Architect** — Researches the codebase, designs solutions, evaluates tradeoffs, and decomposes work into implementable task plans and runbooks
- **Engineer** — Executes code-writing work in two modes: implementation (new code per a task plan) or fix (targeted bug or violation fixes)
- **Tester** — Fills integration test gaps and verifies coverage after implementation
- **Reviewer** — Reviews code for principle compliance and code quality
- **Evaluator** — Lightweight post-implement/fix quality gate; interprets pre-computed structural signals (pattern findings, scope overlap, diff stats) against acceptance criteria and returns a PASS/FAIL verdict
- **Security** — Performs security assessments on implemented code
- **Scribe** — Updates CLAUDE.md files and context documents after implementation
- **Shipper** — Handles final shipping decisions and PR preparation
- **Writer** — Creates and edits Canon principles and agent-behavior rules
- **Learner** — Analyzes patterns and proposes improvements to principles

Agents running at different tiers use different models. The reviewer, architect, and security agents use the most capable model because their jobs require deep reasoning. The evaluator runs on the fastest model since it interprets pre-computed signals rather than raw code. The rest use a mid-tier model to keep iteration loops quick.

## File Format

Each agent definition is a markdown file with YAML frontmatter:

```yaml
---
name: canon-{role}
description: >-
  One to three sentences describing what this agent does,
  when it is spawned, and what it produces.
model: sonnet | opus
color: {terminal-color}
tools:
  - Read
  - Write
  - Bash
  - ...
---
```

The body after the frontmatter is the agent's system prompt — plain English instructions that Canon injects verbatim into the agent's context at spawn time.

## How to Modify an Agent

Open the agent's markdown file and edit the body. The frontmatter controls identity and permissions; the body controls behavior. When you change an agent's instructions, run the Canon eval suite to verify that intent classification and flow routing still work correctly:

```
/canon:check
```

For substantive behavioral changes, consider writing an eval case in `skills/canon/evals/` to capture the new expected behavior before modifying the agent.

## How to Add a New Agent

Create a new file named `canon-{role}.md`. Add frontmatter with the agent's name, a concise description, the appropriate model tier, and the tools it needs. Write clear behavioral instructions in the body. Then register the agent's spawn point in the relevant flow definition (`flows/`) so the orchestrator knows when to use it.

Keep agent instructions specific to the role. Cross-cutting behavior (template usage, workspace logging, evidence standards) is handled by the rules in `rules/` and reference fragments in `references/` — agents load those separately, so you don't need to repeat that content here.
