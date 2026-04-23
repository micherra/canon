## Plan Index: v2.1a — Vocabulary + Synthesis

> **Entry gate:** Gate A (v2 Phase 1 exit criteria met — `planner` and `engineer` agents exist and validate in ≥ 3 runs). See `docs/agent-teams-migration-plan-v2.md` §15.1.
>
> **Review prerequisites:** architect-review HIGH-1 items (L4 allowlist + intent-routing expansion) must have a resolution path before Wave 3 ships. See `docs/agent-teams-migration-plan-v2.1-review.md` §4.1 HIGH-1.

| Task | Wave | Depends on | Key files | Description |
|------|------|------------|-----------|-------------|
| v2_1a-pre | 0 | — | `docs/v2.1a-preflight.md` | Pre-flight environment verification (Gate A state, phase1-10 amendment status, agent frontmatter, test conventions, migration-runner convention, worktree metadata). Files remediation tasks for any gaps before Wave 1 begins. |
| v2_1a-pre-01 | 0 | v2_1a-pre | `phase1/phase1-10-PLAN.md` | Rewrite phase1-10-PLAN.md against v2.1 section 10.5 criteria. Remove static-runbook checks, add four-field preload + planner/engineer validation. Blocks phase1-10 execution but not v2_1a-00. |
| v2_1a-00 | 1 | v2_1a-pre | `references/runbook-vocabulary.md` | Create canonical 15-ID step vocabulary with versioned-change discipline |
| v2_1a-01 | 2 | v2_1a-00 | `references/planner-brief.md` | Create strategic-brief skill defining planning-brief.md contract |
| v2_1a-02 | 2 | v2_1a-00 | `references/runbook-synthesis.md` | Create synthesis skill with MUST/MAY/MUST NOT contract, step schema, iterate-until-approved loop |
| v2_1a-03 | 3 | v2_1a-01, v2_1a-02 | `agents/planner.md` | Rewrite planner body to load both skills, emit brief+runbook, run iterate-until-approved |
| v2_1a-04 | 3 | Wave 2 | `CLAUDE.md` | Amend with L1 per-message intent re-classification + pre-write gate guidance |
| v2_1a-05 | 3 | Wave 2 | `hooks/canon-agent-teams/canon-workspace-check.sh`, `hooks/canon-agent-teams/hooks.json` | L4 PreToolUse hook with .gitignore-based allowlist (review HIGH-1) |
| v2_1a-06 | 2 | — | `CLAUDE.md`, `agents/writer.md`, `agents/learner.md`, `references/content-flow.md` | Intent-routing expansion: principle / learn / docs intents create workspaces (review HIGH-1 prerequisite for L4). No deps — can run in parallel with v2_1a-01 and v2_1a-02. |
| v2_1a-07 | 4 | Wave 3 | `docs/v2.1a-coldstart-spike.md` | Pre-ship cold-start friction spike: 3 trivial requests, measure iteration-0 latency (review MEDIUM-6). **Completed** — CONDITIONAL PASS under revised targets (30s REDIRECT / 60s GREENLIGHT); see spike report §11 |
| v2_1a-07-fix | 4.5 | Wave 4 | `agents/planner.md`, `CLAUDE.md` | Cold-start latency mitigation: skip worktree for plan-mode agents, add cold-start KG awareness. Required before v2_1a-08 proceeds (spike FAIL resolution). |
| v2_1a-08 | 5 | v2_1a-07-fix | `docs/v2.1a-validation-report.md` | Cross-artifact validation against ≥ 5 distinct request types |

### Wave Summary

**Wave 0** (1 task): Pre-flight environment verification. Must pass before Wave 1 begins. Absorbs fresh-review findings that require filesystem facts.

**Wave 1** (1 task): Create canonical step vocabulary. Depends on Wave 0 pre-flight.

**Wave 2** (3 tasks, parallel): Planner-brief and runbook-synthesis skills (both depend on Wave 1 vocabulary); intent-routing expansion (no deps — moved from Wave 3 per fresh review; writer/learner routing doesn't require the synthesis skills).

**Wave 3** (3 tasks, parallel after Wave 2):
- v2_1a-03 rewrites the planner body
- v2_1a-04 amends CLAUDE.md with L1
- v2_1a-05 ships the L4 hook
- L4 (v2_1a-05) MUST NOT land before intent-routing expansion (v2_1a-06) from Wave 2 clears, otherwise L4 blocks writer / learner flows

**Wave 4** (1 task): Cold-start friction spike. **Completed** — FAIL on original 20s target (0/9). Escalated to Wave 4.5 mitigation.

**Wave 4.5** (1 task): Cold-start latency mitigation. **Completed** — 4 fixes applied, re-run FAIL on 20s target (1/9), revised to 30s/60s → CONDITIONAL PASS (7/9). Target revision committed in Wave 5 prep. Planner efficiency filed as v2_1b-09.

**Wave 5** (1 task): Cross-artifact validation. Requires spike (including mitigation re-run) to pass.

### Deferred cleanup

- **Flatten `hooks/canon-agent-teams/` → `hooks/`.** Once `CANON_AGENT_TEAMS_MODE` flag is removed and agent-teams becomes the only mode, the `canon-agent-teams` subdirectory is a vestigial namespace. Merge its hooks and `hooks.json` into the top-level `hooks/` directory in the wave that removes the flag gate.

### Exit criteria

v2.1a is complete when all 9 tasks pass their "Done when" criteria and the design document's dc-01 through dc-09 are satisfied. See `docs/agent-teams-migration-plan-v2.md` §10.2 exit criteria for the top-level gate.

### Relationship to v2 Phase 1

v2.1a builds on top of v2 Phase 1. Gate A (`planner` + `engineer` exist and validate) is a hard precondition. See `.canon/workspaces/agent-teams-v2/plans/phase1/INDEX.md` for Phase 1 task status.

### Relationship to v2.1b

v2.1b (lifecycle persistence substrate) begins only after v2.1a ships and produces ≥ 20 synthesized runbooks in real use. See `.canon/workspaces/agent-teams-v2/plans/v2_1b/INDEX.md`.

### Filed v2.1b follow-up

**v2_1b-09 — Planner efficiency.** Filed from Wave 5 target revision. Reduces the planner's cold-start latency floor below the revised targets (30s/60s). Expected surfaces: preload trimming, selective caching, scope-conditional evidence thresholds. See `.canon/workspaces/agent-teams-v2/plans/v2_1b/v2_1b-09-PLAN.md`.
