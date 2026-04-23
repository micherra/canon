---
task_id: "v2_1b-10"
wave: ~
depends_on: []
decisions: []
files: []
principles: []
domains:
  - orchestration
---

## Task: Mandatory tail enforcement under compact output

> **Filed from:** v2.1a cross-artifact validation report (NF-6, `docs/v2.1a-validation-report.md` §15).
> **Status:** STUB — do not implement until v2.1b planning begins.

### Goal

Ensure synthesized runbooks always include the mandatory tail (context-sync → learn) even when the planner produces output under compact conditions (token pressure, high turn count, summarized preload).

### Motivation

NF-6 from the v2.1a validation report: "S5' runbook omits the mandatory tail (context-sync → learn). The synthesis contract requires it. This is a minor contract deviation — the planner produced the runbook under a compact output constraint, and the tail is a mechanical addition."

The tail omission does not affect synthesis correctness (step selection, confidence signals, contract pairings are all correct), but it violates the synthesis contract and could cause downstream issues if the orchestrator relies on the tail steps being present in every runbook.

### Expected surfaces

1. **`canon:synthesize` SKILL.md enforcement language.** Strengthen the synthesis contract to explicitly require the tail in all output modes. Add a "MUST include" clause for context-sync → learn that cannot be elided under token pressure.

2. **Post-synthesis validation check.** Add a lightweight check (either in the planner's synthesis skill or as an orchestrator-side post-check) that verifies the final runbook contains the mandatory tail steps before accepting it.

3. **Preload optimization.** If the tail omission correlates with preload size causing token pressure, the v2_1b-09 preload trimming work may indirectly reduce this failure mode.

### Canon principles to apply

TBD — stub for future planning.

### Risk mitigations

TBD — stub for future planning.

### Tests to write

TBD — stub for future planning.

### Verify

TBD — stub for future planning.

### Done when

TBD — stub for future planning.
