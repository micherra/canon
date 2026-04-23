---
task_id: "v2_1b-09"
wave: ~
depends_on: []
decisions: []
files: []
principles:
  - agent-evidence-over-intuition
domains:
  - infrastructure
---

## Task: Planner efficiency — reduce cold-start floor

> **Filed from:** v2.1a Wave 5 target revision (see `docs/v2.1a-coldstart-spike.md` §11).
> **Status:** STUB — not to be implemented until v2.1b planning begins.

### Goal

Reduce the planner's cold-start iteration-0 latency floor below the revised targets (30s median REDIRECT / 60s median GREENLIGHT) established in v2.1a.

### Motivation

The revised targets represent the current architectural floor, not an aspirational endpoint. The floor is principled — driven by evidence-gathering requirements (`agent-evidence-over-intuition`) and agent initialization overhead — but the user patience window is 15–30s. Closing the gap between floor and patience window improves the iterate-until-approved experience without sacrificing plan quality.

### Expected surfaces

1. **Preload trimming.** The planner receives ~25KB of preloaded content via `resolve_agent_skills`. Profile which rules, references, and templates are consumed per request type and trim unused content.

2. **Selective caching of plan/synthesize content.** The synthesis contract and vocabulary are stable across spawns. Cache them in agent memory so subsequent spawns skip re-reading.

3. **Scope-conditional evidence thresholds.** For trivial, fully-specified requests (single-file, unambiguous scope), reduce the evidence-gathering floor — skip `get_file_context` and `graph_query` calls when the request provides complete targeting information. Current behavior: planner always gathers evidence regardless of specificity (R3 regression in §10 re-run).

### Canon principles to apply

- **agent-evidence-over-intuition** — evidence reduction must preserve the planner's quality guarantee; the principle constrains optimization

### Risk mitigations

TBD — stub for future planning.

### Tests to write

TBD — stub for future planning.

### Verify

TBD — stub for future planning.

### Done when

TBD — stub for future planning.
