## Plan Index: v2.1a — Vocabulary + Synthesis

> **Entry gate:** Gate A (v2 Phase 1 exit criteria met — `canon-planner` and `canon-engineer` agents exist and validate in ≥ 3 runs). See `docs/agent-teams-migration-plan-v2.md` §15.1.
>
> **Review prerequisites:** architect-review HIGH-1 items (L4 allowlist + intent-routing expansion) must have a resolution path before Wave 3 ships. See `docs/agent-teams-migration-plan-v2.1-review.md` §4.1 HIGH-1.

| Task | Wave | Depends on | Key files | Description |
|------|------|------------|-----------|-------------|
| v2_1a-00 | 1 | — | `skills/canon/references/runbook-vocabulary.md` | Create canonical 15-ID step vocabulary with versioned-change discipline |
| v2_1a-01 | 2 | v2_1a-00 | `skills/canon/references/planner-brief.md` | Create strategic-brief skill defining planning-brief.md contract |
| v2_1a-02 | 2 | v2_1a-00 | `skills/canon/references/runbook-synthesis.md` | Create synthesis skill with MUST/MAY/MUST NOT contract, step schema, iterate-until-approved loop |
| v2_1a-03 | 3 | v2_1a-01, v2_1a-02 | `agents/canon-planner.md` | Rewrite canon-planner body to load both skills, emit brief+runbook, run iterate-until-approved |
| v2_1a-04 | 3 | Wave 2 | `CLAUDE.md` | Amend with L1 per-message intent re-classification + pre-write gate guidance |
| v2_1a-05 | 3 | Wave 2 | `hooks/canon-agent-teams/canon-workspace-check.sh`, `hooks/canon-agent-teams/hooks.json` | L4 PreToolUse hook with .gitignore-based allowlist (review HIGH-1) |
| v2_1a-06 | 2 | — | `CLAUDE.md`, `agents/canon-writer.md`, `agents/canon-learner.md`, `skills/canon/references/content-flow.md` | Intent-routing expansion: principle / learn / docs intents create workspaces (review HIGH-1 prerequisite for L4). No deps — can run in parallel with v2_1a-01 and v2_1a-02. |
| v2_1a-07 | 4 | Wave 3 | `docs/v2.1a-coldstart-spike.md` | Pre-ship cold-start friction spike: 3 trivial requests, measure iteration-0 latency (review MEDIUM-6) |
| v2_1a-08 | 5 | Wave 4 | `docs/v2.1a-validation-report.md` | Cross-artifact validation against ≥ 5 distinct request types |

### Wave Summary

**Wave 1** (1 task): Create canonical step vocabulary. No dependencies — foundation for all downstream skills.

**Wave 2** (3 tasks, parallel): Planner-brief and runbook-synthesis skills (both depend on Wave 1 vocabulary); intent-routing expansion (no deps — moved from Wave 3 per fresh review; canon-writer/canon-learner routing doesn't require the synthesis skills).

**Wave 3** (3 tasks, parallel after Wave 2):
- v2_1a-03 rewrites the planner body
- v2_1a-04 amends CLAUDE.md with L1
- v2_1a-05 ships the L4 hook
- L4 (v2_1a-05) MUST NOT land before intent-routing expansion (v2_1a-06) from Wave 2 clears, otherwise L4 blocks canon-writer / canon-learner flows

**Wave 4** (1 task): Cold-start friction spike. Needs the full integrated system to run against.

**Wave 5** (1 task): Cross-artifact validation. Requires spike to pass.

### Exit criteria

v2.1a is complete when all 9 tasks pass their "Done when" criteria and the design document's dc-01 through dc-09 are satisfied. See `docs/agent-teams-migration-plan-v2.md` §10.2 exit criteria for the top-level gate.

### Relationship to v2 Phase 1

v2.1a builds on top of v2 Phase 1. Gate A (`canon-planner` + `canon-engineer` exist and validate) is a hard precondition. See `.canon/workspaces/agent-teams-v2/plans/phase1/INDEX.md` for Phase 1 task status.

### Relationship to v2.1b

v2.1b (lifecycle persistence substrate) begins only after v2.1a ships and produces ≥ 20 synthesized runbooks in real use. See `.canon/workspaces/agent-teams-v2/plans/v2_1b/INDEX.md`.
