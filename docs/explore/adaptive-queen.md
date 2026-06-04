# Exploration: The "Adaptive Queen" coordinator (deferred)

> Status: parked / not scheduled. Source: deep-dive of the external ruflo/claude-flow
> framework, 2026-06-03. Parked alongside the wave-merge phantom reconcile (see decision
> `wave-merge-01` in the `reconcile-the-deleted-wave-merge-tooling` build — the same evidence
> that parallel-wave execution is currently dead is why an in-flight wave monitor has no
> substrate to run on yet).

## 1. The concept

Ruflo splits the swarm coordinator into **three typed Queens**:

- **Strategic Queen** — owns the high-level plan: topology selection and role assignment.
  (Canon analog: the architect's design + runbook + task DAG.)
- **Tactical Queen** — owns step-by-step execution and conflict resolution. (Canon analog:
  the orchestrator's runbook execution loop + merge/HITL handling.)
- **Adaptive Queen** — the novel piece. It **continuously monitors** swarm performance and
  **reconfigures the swarm in real time** when something isn't working, *before* the failing
  unit actually fails.

Most harnesses — Canon included — have a single coordinator role and only react *after* a
failure occurs. Canon's closest analog is the reactive **Auto-Escalation Protocol**
(`get_next_escalation_strategy`: `add_primer → increase_budget → escalate_model →
narrow_scope → hitl`), which fires only once a step has already failed or stalled
(`isStuck`).

A Canon-shaped Adaptive Queen would be a **lightweight standing monitor** that watches a
running build/wave and re-routes or re-partitions a thrashing task *before* it fails — e.g.
bump a stuck task to Opus, or re-split an over-large task — rather than waiting for the
failure signal. It is the *proactive* sibling of the *reactive* Auto-Escalation cascade: same
remediation menu, applied earlier on a leading indicator instead of a failure event.

## 2. Why deferred

- **It fights Canon's deterministic-governance identity.** A standing monitor that
  reconfigures a running swarm introduces emergent, hard-to-audit behavior: the same build
  could take different paths on different runs depending on live telemetry. Canon's value
  proposition is a deterministic, replayable, auditable spine. Continuous in-flight
  reconfiguration is at odds with that.
- **Auto-Escalation already captures ~80% of the value at none of the cost.** The reactive
  cascade applies the same remediations (primer, budget, model, scope, HITL) with a clear,
  auditable trigger (a step failed or stalled). The marginal gain from acting a few moments
  *earlier* on a leading indicator does not justify the added complexity and loss of
  determinism — yet.
- **There is no parallel-wave substrate to monitor today.** Parallel wave execution is
  currently dead (wave-lifecycle tooling removed in PR #167; see `wave-merge-01`). A
  continuous wave monitor would have little to watch in the predominant single-worktree
  sequential path.

## 3. Revisit trigger

Reconsider this concept **only if parallel-wave builds become frequent** — i.e. real builds
routinely fan out into many concurrent worker tasks where a single thrashing task materially
delays the wave. That same threshold is the revisit trigger for restoring the deleted
wave-merge tooling (decision `wave-merge-01`): if parallelism is rebuilt as a real,
exercised path, a proactive monitor over it becomes worth re-evaluating. Until then, the
reactive Auto-Escalation Protocol is the supported mechanism.

If revisited, scope the smallest possible version first: a single leading indicator (e.g.
turns-elapsed vs. budget) driving a single proactive remediation (model bump), shadow-logged
before it is allowed to act — consistent with Canon's shadow-first rollout pattern.
