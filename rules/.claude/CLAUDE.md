# Canon Rules — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-09 -->
Agent-behavior rules loaded at runtime to constrain how specialist agents operate. Rules are imperative directives — not design principles — that govern agent execution patterns.

## Architecture
<!-- last-updated: 2026-04-09 -->

Each rule is a standalone markdown file named with the `agent-` prefix (e.g., `agent-tdd-required.md`). The agent spawner selects which rules to inject into an agent's context based on the agent type and flow state.

Rules are organized into behavioral categories:

- **Artifact rules** — govern what agents must produce (`agent-artifacts-only`, `agent-template-required`, `agent-missing-artifact`, `agent-artifact-write-before-return`)
- **Research rules** — govern how agents investigate (`agent-scoped-research`, `agent-evidence-over-intuition`, `agent-surface-assumptions`)
- **Implementation rules** — govern how agents write code (`agent-tdd-required`, `agent-minimal-fix`, `agent-simplify-before-extending`, `agent-structured-triage`, `agent-document-public-apis`)
- **Design rules** — govern pre-code planning (`agent-design-before-code`, `agent-plans-are-prompts`)
- **Testing rules** — govern test quality (`agent-test-sad-paths`, `agent-test-the-contract`)
- **Coordination rules** — govern agent collaboration (`agent-fresh-context`, `agent-workspace-scoping`, `agent-conflict-detection`, `agent-context-sync`, `agent-convergence-discipline`, `agent-document-decisions`, `agent-worktree-orientation`)
- **Review rules** — govern review behavior (`agent-cold-review`, `agent-assume-hostile-input`)

## Conventions
<!-- last-updated: 2026-04-09 -->

- Rules are imperative constraints, not principles — they tell agents exactly what to do or not do
- Rules differ from `principles/` in that they govern agent execution behavior, not code quality
- Each rule file is loaded verbatim into agent context; keep files concise and actionable
- New rules follow the `agent-{behavior-name}.md` naming convention
