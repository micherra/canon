## Plan Index: v2.1b — Minimum Viable Lifecycle Persistence

> **Entry gate:** v2.1a shipped and produced ≥ 20 real-use synthesized runbooks. See `docs/agent-teams-migration-plan-v2.md` §10.3 and `.canon/workspaces/agent-teams-v2/plans/v2_1a/INDEX.md` exit criteria.
>
> **Gate B (ratification):** ≥ 1 principle-refinement proposal produced, accepted by a human reviewer, and applied as an actual edit to a principle file — end-to-end observation → pattern → proposal → refinement loop closed. See `docs/agent-teams-migration-plan-v2.md` §15.2. dc-08 / v2_1b-07 is this task.

| Task | Wave | Depends on | Key files | Description |
|------|------|------------|-----------|-------------|
| v2_1b-00 | 1 | — | `mcp-server/src/platform/storage/drift/drift-schema.ts`, migration file | Add `lifecycle_workspace_snapshots` table per §8.1 DDL; migration versioned and reversible |
| v2_1b-01 | 2 | v2_1b-00 | `mcp-server/src/features/diagnostics/tools/snapshot-workspace.ts`, registration | `snapshot_workspace({ workspace_id })` MCP tool; idempotent |
| v2_1b-02 | 3 | v2_1b-01 | `hooks/canon-agent-teams/completion-verify.sh` | Extend hook to call `snapshot_workspace` after `verify_completion` clears; block if snapshot fails |
| v2_1b-03 | 3 | — | `templates/fix-summary.md` (new or amended), `agents/canon-engineer.md` | Fix-summary tags: `cause`, `root_cause_tag`. Engineer populates on fix runs. |
| v2_1b-04 | 3 | — | `templates/implementation-log.md`, `agents/canon-engineer.md` | Implementation-summary tag: `justified_deviations[]`. Engineer populates when deviating with Canon justification. |
| v2_1b-05 | 3 | — | `templates/review-checklist.md`, `agents/canon-reviewer.md` | Review-finding `principle_id` consistency — enforce existing field population via template + reviewer prompt |
| v2_1b-06 | 4 | v2_1b-01, v2_1b-03, v2_1b-04, v2_1b-05 | `agents/canon-learner.md` | Extend learner with principle-refinement analysis dimension; reads lifecycle snapshots + drift-store violations; produces structured patches to principle files |
| v2_1b-07 | 5 | v2_1b-06 | `docs/v2.1b-gateB-evidence.md`, `principles/*.md` (edit), `.canon/learning.jsonl` | Gate B evidence run: produce ≥ 1 accepted, applied principle-refinement proposal end-to-end |
| v2_1b-08 | 6 | v2_1b-07 | `docs/v2.1b-validation-report.md` | Cross-artifact validation of the full substrate |

### Wave Summary

**Wave 1** (1 task): Schema migration. No deps. Must ship first because everything else writes to or reads from the new table.

**Wave 2** (1 task): `snapshot_workspace` MCP tool. Depends on Wave 1 schema.

**Wave 3** (4 tasks, parallel): Completion-verify hook extension (depends on Wave 2 tool) + three structured tag additions (independent; each is a small template change + agent body rule). These four run in parallel after v2_1b-01 lands.

**Wave 4** (1 task): Learner extension. Depends on Wave 2 tool (to read lifecycle snapshots) and Wave 3 tags (review findings must have `principle_id`; fix summaries must have `cause`).

**Wave 5** (1 task): Gate B evidence — the ratification proof. Must produce a concrete accepted + applied principle-refinement proposal.

**Wave 6** (1 task): Cross-artifact validation. Gate B evidence is one accepted proposal; v2_1b-08 validates the full cycle works across the substrate.

### Exit criteria

v2.1b is complete when all 9 tasks pass their "Done when" criteria, dc-01 through dc-09 are satisfied, and Gate B evidence is committed to `docs/v2.1b-gateB-evidence.md`. See `docs/agent-teams-migration-plan-v2.md` §§10.3, 15.2 for the top-level gate.

### Relationship to v2.1a

v2.1b entry gate (≥ 20 synthesized runbooks in real use from v2.1a) ensures the learning loop has real data to work with. If v2.1a produces fewer runbooks, v2.1b is premature — the data corpus is too thin for credible principle-refinement analysis. See `.canon/workspaces/agent-teams-v2/plans/v2_1a/INDEX.md`.

### Relationship to v2.2

v2.2 expands on v2.1b's proven substrate. Entry gate for v2.2 is ≥ 3 proposals with ≥ 1 accepted **plus** the review MEDIUM-1 quality criterion (accepted proposal produces measurable improvement, not just acceptance). v2.1b's Gate B is the first of those ≥ 1 accepted. See `docs/agent-teams-migration-plan-v2.md` §10.4.
