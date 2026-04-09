---
fragment: pre-launch-check
description: Deterministic gate that runs discovered quality checks before shipping
entry: pre-launch-check

params:
  after_passing:
    type: state_id

states:
  pre-launch-check:
    type: single
    transitions:
      done: ${after_passing}
      blocked: hitl
---

## Description

Gate-only state — no agent is spawned. The runtime collects all quality-check commands that agents discovered during the build (test commands from the tester, lint commands from the reviewer, build commands from the implementor) and executes them deterministically. Language-agnostic: works with any project regardless of toolchain.

If all discovered gates pass, transitions to `${after_passing}`. If any gate fails, transitions to `hitl` for manual resolution. If no gates were discovered, fails closed.

Flows can override with explicit gates via the `overrides` mechanism if needed:

```yaml
- fragment: pre-launch-check
  with:
    after_passing: ship
  overrides:
    pre-launch-check:
      gates: ["make build", "make test", "make lint"]
```
