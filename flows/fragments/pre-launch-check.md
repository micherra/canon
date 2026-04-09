---
fragment: pre-launch-check
description: Deterministic gate that verifies build and test pass before shipping
entry: pre-launch-check

params:
  after_passing:
    type: state_id

states:
  pre-launch-check:
    type: single
    gates:
      - "npm run build"
      - "npm test"
    transitions:
      done: ${after_passing}
      blocked: hitl
---

## Description

Gate-only state — no agent is spawned. The runtime executes each command in `gates` sequentially. If all commands pass, transitions to `${after_passing}`. If any command fails, transitions to `hitl` for manual resolution.

Flows can override the default gates via the `overrides` mechanism:

```yaml
- fragment: pre-launch-check
  with:
    after_passing: ship
  overrides:
    pre-launch-check:
      gates: ["make build", "make test", "make lint"]
```
