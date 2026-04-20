---
done_criteria:
  - id: "dc-01"
    description: "lifecycle_workspace_snapshots table exists in drift-db.sqlite per the DDL in v2.1 §8.1; migration is versioned and reversible."
    testable: "drift-schema migration runner applies the DDL cleanly. DROP TABLE reverses it without data loss on an empty install. Table has expected columns + indexes."
  - id: "dc-02"
    description: "snapshot_workspace MCP tool exists; accepts workspace_id; writes a row to lifecycle_workspace_snapshots; is idempotent."
    testable: "Tool registered in MCP server. Calling snapshot_workspace({ workspace_id }) on a completed workspace writes one row and returns { snapshot_id }. Re-calling updates, not duplicates."
  - id: "dc-03"
    description: "completion-verify.sh hook extended to call snapshot_workspace after verify_completion clears. Failure in either step blocks flow completion."
    testable: "Hook integration test: completing a flow triggers snapshot_workspace call; snapshot row exists post-verify. If snapshot fails, the flow is not marked complete."
  - id: "dc-04"
    description: "Fix summary template carries `cause` and `root_cause_tag` structured tags. canon-engineer populates them in fix flows."
    testable: "templates/fix-summary.md has the fields. A canon-engineer fix run produces a fix summary with both tags populated. Indexer parses and stores them."
  - id: "dc-05"
    description: "Implementation summary template carries `justified_deviations[]` structured tag. canon-engineer populates it when deviating from plans with Canon justification."
    testable: "templates/implementation-log.md has the field. A canon-engineer run with a justified deviation produces the tag. Indexer parses and stores."
  - id: "dc-06"
    description: "Review finding `principle_id` consistency — existing drift-db field is consistently populated by reviewer in all findings. Review template makes this explicit."
    testable: "templates/review-checklist.md requires principle_id per finding. A canon-reviewer run against a test flow produces all findings with principle_id set. drift-store query returns no null principle_id rows for v2.1b-era reviews."
  - id: "dc-07"
    description: "canon-learner extended with a principle-refinement analysis dimension. Learner reads lifecycle_workspace_snapshots + drift-store violations and produces structured patch proposals to principle files."
    testable: "canon-learner.md body specifies the new dimension. Running the learner against real data produces ≥ 1 structured proposal in .canon/proposed-learnings/{timestamp}/ targeting a specific principle file with a patch."
  - id: "dc-08"
    description: "Gate B evidence: ≥ 1 principle-refinement proposal produced by the learner against real lifecycle data, accepted by a human reviewer, and applied as an actual edit to a principle file. End-to-end observation → pattern → proposal → refinement loop closed."
    testable: "docs/v2.1b-gateB-evidence.md records the proposal, the review decision, the applied edit, and the resulting principle file diff. .canon/learning.jsonl records the accepted decision. The edited principle is in main."
  - id: "dc-09"
    description: "Cross-artifact validation confirms the v2.1b minimum persistence substrate functions end-to-end: schema migration, snapshot on completion, tag capture, learner analysis, human curation, applied refinement."
    testable: "docs/v2.1b-validation-report.md records the full cycle for at least one flow from flow-start to applied refinement. No failures in any step."
---

## Design: v2.1b — Minimum Viable Lifecycle Persistence

### North Star

**Vision:** Canon's learning loop (observation → pattern → proposal → refinement) closes end-to-end for **one refinement target** (principles) against **one persistence substrate** (a single new drift-db table + one MCP tool). Proves the loop works before v2.2 expands surface.

**Done when:** dc-01 through dc-09 all pass. Gate B evidence (dc-08) is the ratification-gate criterion per `docs/agent-teams-migration-plan-v2.md` §15.2.

**Constraints:**

- v2.1a complete + ≥ 20 synthesized runbooks observed in real use (entry gate per `docs/agent-teams-migration-plan-v2.md` §10.3)
- ONE new table (`lifecycle_workspace_snapshots`); additional tables defer to v2.2
- ONE new MCP tool (`snapshot_workspace`); `query_workspace_history` defers to v2.2
- THREE structured tag additions (`cause` + `root_cause_tag` on fix summary; `justified_deviations[]` on implementation summary; enforce `principle_id` on review findings)
- ONE new learner analysis dimension (principle refinement); other dimensions defer to v2.2
- Supervised curation only (weekly human review of `.canon/proposed-learnings/{timestamp}/`); automation defers to v2.2+ per §3.4

### Approach

v2.1b decomposes into three layers that ship sequentially:

1. **Persistence layer** (Waves 1–2) — drift-db schema migration, then the `snapshot_workspace` MCP tool that writes to it.
2. **Capture layer** (Wave 3) — completion-verify hook extension plus the three structured tag additions. Each tag is a small template change + agent-side population rule; they can run in parallel.
3. **Analysis layer** (Wave 4) — the canon-learner extension that reads captured data and proposes principle refinements.
4. **Evidence layer** (Wave 5) — Gate B evidence run: produce ≥ 1 accepted, applied refinement proposal. This is the ratification proof.
5. **Validation layer** (Wave 6) — cross-artifact validation of the complete v2.1b substrate.

### Canon principle alignment

- **agent-design-before-code** — DESIGN + INDEX precede implementation
- **agent-evidence-over-intuition** — Gate B is explicit evidence; dc-08 is satisfied by a concrete artifact (an applied principle edit traced from observation to refinement)
- **agent-plans-are-prompts** — each PLAN is self-contained; implementors work from the plan file

### Key references

- Architectural source: `docs/agent-teams-migration-plan-v2.1.md` §§3, 4, 8
- Implementation plan: `docs/agent-teams-migration-plan-v2.md` §§3, 4, 8, 10.3
- Architect review: `docs/agent-teams-migration-plan-v2.1-review.md` (MEDIUM-3 journal field-quality — applies via dc-04..06 on tag discipline; MEDIUM-5 on lifecycle/workspace boundary — in scope for v2.1b's §8.2 boundary decision)

### Risks

See `docs/agent-teams-migration-plan-v2.md` §13. v2.1b-specific risks:

- Observation tag compliance (LOW) — closed schema per §4.6; this task honors that
- Learner scope creep (MEDIUM/LOW) — §3.3 explicitly restricts v2.1b to principle refinement only
- Orchestration journal field quality (MEDIUM/MEDIUM per review MEDIUM-3) — v2.1b's tag additions amplify journal dependence; validation ensures tags are populated, not just present

### Relationship to v2.2

v2.2 expands on v2.1b's proven substrate:

- Additional lifecycle tables (`lifecycle_synthesized_runbooks` with iteration tracking, `lifecycle_step_executions`, `lifecycle_hitl_events`, `lifecycle_runbook_deviations`)
- Additional structured tags
- Embeddings + `similar_to` semantic search
- Additional refinement targets (conventions, synthesis skill, planning brief skill, templates)
- Cross-target analyses
- Confidence calibration decisions (possibly reintroducing user-facing aggregate under gate-eligibility rules)

v2.2 entry gate per `docs/agent-teams-migration-plan-v2.md` §10.4: v2.1b shipped ≥ 3 proposals with ≥ 1 accepted — **plus** review MEDIUM-1 quality criterion (accepted proposal produces measurable improvement).
