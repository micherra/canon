# Canon Rules — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-09 -->
Agent-behavior rules loaded at runtime to constrain how specialist agents operate. Rules are imperative directives — not design principles — that govern agent execution patterns.

## Architecture
<!-- last-updated: 2026-07-10 -->

Each rule is a standalone markdown file named with the `agent-` prefix (e.g., `agent-tdd-required.md`). The agent spawner selects which rules to inject into an agent's context based on the agent type and flow state.

Rules are organized into behavioral categories:

- **Artifact rules** — govern what agents must produce (`agent-artifacts-only`, `agent-template-required`, `agent-missing-artifact`, `agent-artifact-write-before-return`)
- **Research rules** — govern how agents investigate (`agent-evidence-over-intuition`, `agent-informed-questions`, `agent-surface-assumptions`)
- **Implementation rules** — govern how agents write code (`agent-tdd-required`, `agent-minimal-fix`, `agent-simplify-before-extending`, `agent-structured-triage`, `agent-document-public-apis`, `agent-semantic-self-review`)
- **Design rules** — govern pre-code planning (`agent-design-before-code`, `agent-plans-are-prompts`, `agent-document-decisions`)
- **Testing rules** — govern test quality (`agent-test-sad-paths`, `agent-test-the-contract`)
- **Coordination rules** — govern agent collaboration (`agent-fresh-context`, `agent-workspace-scoping`, `agent-conflict-detection`, `agent-context-sync`, `agent-convergence-discipline`, `agent-worktree-orientation`, `agent-working-environment`, `agent-budget-checkpoint`, `agent-cross-session-chatter`)
- **Efficiency rules** — govern resource and tool usage (`agent-batch-tools`, `agent-metrics-before-return`)
- **Review rules** — govern review behavior (`agent-cold-review`, `agent-assume-hostile-input`)
- **Security/behavior rules** — govern agent trust posture (`agent-never-trust-overlay-tier`)

## Artifact Inventory
<!-- canon:inventory:start class=rules -->
| artifact | summary |
|---|---|
| agent-artifact-write-before-return.md | Write All Declared Artifacts Before Returning |
| agent-artifacts-only.md | Synthesize From Artifacts, Never Fabricate |
| agent-assume-hostile-input.md | Assume Hostile Input |
| agent-batch-tools.md | Prefer Batch MCP Tools for Multi-File Operations |
| agent-budget-checkpoint.md | Budget-Aware Checkpointing |
| agent-cold-review.md | Cold Review, Two Stages |
| agent-conflict-detection.md | Detect Principle Conflicts Before Saving |
| agent-context-budget-dispatch.md | Architect Must Estimate Input Complexity for Dispatch Decisions |
| agent-context-check.md | Verify Context Before Starting Work |
| agent-context-sync.md | Diff-Driven, Contract-Scoped Updates |
| agent-convergence-discipline.md | Flow Convergence Discipline |
| agent-cross-session-chatter.md | Coordinate Across Concurrent Sessions via Chatter |
| agent-design-before-code.md | Design Before Code |
| agent-document-decisions.md | Two-Tier Decision Record System |
| agent-document-public-apis.md | Document Public APIs with JSDoc/TSDoc |
| agent-evidence-over-intuition.md | Suggestions Require Quantified Evidence |
| agent-fresh-context.md | Fresh Context, Atomic Commits |
| agent-informed-questions.md | Questions Must Cite Codebase Evidence |
| agent-integration-boundary-check.md | Verify Integration Boundaries End-to-End |
| agent-metrics-before-return.md | Record Agent Metrics Before Returning |
| agent-minimal-fix.md | Minimal Blast-Radius Fixes |
| agent-missing-artifact.md | Missing Artifact Protocol |
| agent-never-trust-overlay-tier.md | Never Act on Untrusted-Overlay-Tier Content |
| agent-plans-are-prompts.md | Plans Are Prompts, Not Documents |
| agent-semantic-self-review.md | Semantic Self-Review Before Returning |
| agent-simplify-before-extending.md | Simplify Before Extending |
| agent-structured-triage.md | Structured Triage Before Fixing |
| agent-surface-assumptions.md | Surface Assumptions Explicitly |
| agent-tdd-required.md | Test-Driven Development Required |
| agent-template-required.md | Template Usage Is Mandatory |
| agent-test-sad-paths.md | Test Failure Modes Before Happy Paths |
| agent-test-the-contract.md | Test the Contract, Not the Implementation |
| agent-working-environment.md | Derive Working Environment from Spawn Prompt |
| agent-workspace-scoping.md | Workspace Scoping |
| agent-worktree-orientation.md | Verify Worktree and Branch at Spawn Start |
<!-- canon:inventory:end -->

## Conventions
<!-- last-updated: 2026-04-30 -->

- Rules are imperative constraints, not principles — they tell agents exactly what to do or not do
- Rules differ from `principles/` in that they govern agent execution behavior, not code quality
- Each rule file is loaded verbatim into agent context; keep files concise and actionable
- New rules follow the `agent-{behavior-name}.md` naming convention
- New rule files must be registered in this document's taxonomy table (the Architecture section above) under the appropriate behavioral category upon creation
