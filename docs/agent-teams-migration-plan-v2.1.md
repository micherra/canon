# Canon → Agent Teams Migration Plan v2.1

**Status:** DRAFT — proposed revision of v2
**Supersedes:** `docs/agent-teams-migration-plan-v2.md` (v2, 2026-04-12)
**Last updated:** 2026-04-19
**Origin:** `docs/runbook-synthesis-proposal.md` (PR #115; three architect review cycles)
**Ratification gates:** see §15

---

## 1. Context

### 1.1 What v1 got right

The v1 plan correctly identified six durable ideas, all of which still hold in v2.1:

1. **Runbooks as data-over-code.** Linear playbooks describing step sequences are simpler than a state-machine runtime. (v2.1 takes this further: runbooks are *synthesized per plan* from a canonical step vocabulary, not hardcoded files.)
2. **Hook-based artifact enforcement.** `TaskCompleted` + `TeammateIdle` hooks with workspace-local state files is a clean enforcement channel.
3. **Pinned task list for cross-session resume.** `CLAUDE_CODE_TASK_LIST_ID` + `~/.claude/tasks/<id>/` as the durable work-unit substrate.
4. **Feature-flag gating.** `CANON_AGENT_TEAMS_MODE=off` must remain byte-identical to the legacy `drive_flow` path throughout the migration.
5. **Phased rollout with scoped boundaries.** One migration step at a time, each independently verifiable.
6. **Principles and artifacts as the engine's product.** Canon's differentiation lives in those two layers; the coordination layer is commodity scheduling.

### 1.2 What v2 got right

v2's core insight superseded v1's scope:

- **Claude orchestrates natively.** Everything `drive_flow` coordinates (sequencing, conditionals, HITL gates, parallel dispatch, convergence, skip conditions, effects) is native Claude capability. The custom state machine was built before Claude Code had multi-agent coordination; now that it does, the custom scheduler is overhead.
- **Canon's value stays as MCP tools.** Principle-grounded context, drift tracking, knowledge graph queries, artifact contracts, commit provenance, file claims, enrichment — these are MCP tools, not coordination plumbing. They stay.
- **Agent definitions work as-is.** All 11 agent types are valid as subagents and agent-team teammates. The `tools` allowlist, `skills` frontmatter, `permissionMode`, `memory`, `maxTurns` — all native Claude Code capabilities.
- **Lead handles HITL natively.** No custom breakpoint vocabulary; Claude's conversational HITL is richer than fixed shapes.

### 1.3 What v2.1 changes

Two architectural additions on top of v2:

**Canon's learning loop as the unified quality-up mechanism.** v2 preserves principles, drift, and commit provenance as MCP tools but doesn't articulate how Canon's whole stack (principles, synthesis patterns, templates, domain skills, agent prompts) improves from every interaction. v2.1 makes this explicit: observation → pattern → proposal → refinement is one mechanism applied across every Canon refinement target. The learner's role expands accordingly. (See §4.)

**Synthesis replaces static runbooks.** v2 specified 5 hardcoded runbook files (fast-path / feature / epic / migrate / test-gap). v2.1 replaces these with:

- A canonical step vocabulary (15 IDs) — the stable analytic Schelling point
- A `runbook-synthesis.md` skill that defines how the planner composes a runbook from the vocabulary
- A `planner-brief.md` skill that defines how the planner produces the strategic brief
- An iterate-until-approved loop where `canon-planner` proposes a runbook, the user iterates, and approval triggers execution

Static runbooks don't learn — whoever wrote them wrote them once. Synthesis is what makes plan quality learnable alongside principle quality. (See §§5-6.)

Everything in v2.1 preserves v2's additive-phase discipline except for one deliberate enforcement addition (L4 — see §6.2 and §10.2): a new PreToolUse hook that blocks code modification when no active Canon workspace exists for the current flow. Justified by the intent-misclassification drift concern — L1 (CLAUDE.md re-classification rule) alone is prompt discipline; L4 is the hard backstop.

### 1.4 What does not change from v2

Most of v2 stays intact:

- Integration disposition table (see §9)
- Phase 2 (Validation) and Phase 3 (Deletion) structure
- Agent roster (11 types, same as v2)
- Canon MCP tools (unchanged)
- Workspace storage layout (`.canon/workspaces/<id>/`)
- Hooks model (TaskCompleted, PostCommit, SessionStart, SubagentStop)
- Permission model (`plan` for read-only roles; `acceptEdits` for writers)

v2.1 is additive against v2 for everything outside the synthesis and learning-loop additions.
