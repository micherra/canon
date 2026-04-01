# Canon Flows — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Multi-agent state machine pipelines that orchestrate Canon's build, review, and security workflows. Each flow defines states, transitions, and agent spawn instructions.

## Architecture
<!-- last-updated: 2026-03-22 -->

Flows use YAML frontmatter (defining states, transitions, loops, constraints) followed by markdown spawn instructions for each state. See `SCHEMA.md` for the complete specification.

**Flow files:**

| Flow | Tier | Scope |
|------|------|-------|
| `refactor.md` | Medium | Behavior-preserving restructuring with continuous test verification |
| `feature.md` | Medium (4-10 files) | Feature-specific pipeline |
| `migrate.md` | Medium | Staged migration with rollback planning and verification |
| `epic.md` | Large (10+ files) | Adaptive epic pipeline — research, design, wave implementation with replan, test, security, review |
| `explore.md` | Research | Research and report on a codebase question — no implementation |
| `test-gap.md` | Testing | Analyze coverage gaps, write tests, verify, review |
| `review-only.md` | Review | Review existing PR without implementing |
| `security-audit.md` | Security | Dedicated security audit |
| `adopt.md` | Adoption | Scan for violations + auto-fix (invoked by `init` as final step, not a standalone user command) |

**Fragments** (`fragments/`) — Reusable state groups included in flows:
- `context-sync.md`, `review-fix-loop.md`, `implement-verify.md`, `verify-fix-loop.md`, `security-scan.md`, `user-checkpoint.md`, `plan-review.md`, `pattern-check.md`, `early-scan.md`, `impl-handoff.md`, `targeted-research.md`, `test-fix-loop.md`, `ship-done.md`

## Conventions
<!-- last-updated: 2026-03-22 -->

- The orchestrator reads flows at runtime, validates frontmatter, resolves fragment includes
- Looping states have max iterations and stuck detection (`agent-convergence-discipline` rule)
- States define which agent to spawn and what context to pass
- SCHEMA.md is the authoritative reference for flow format
