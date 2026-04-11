# Phase 2 Conversion Notes — Per-Flow Divergences

Status: Phase 2 — draft on `canon/agent-teams-phase-2`.
Related: `docs/agent-teams-migration-plan.md` §6, `docs/phase-1-smoke-test.md`, `skills/canon/runbooks/README.md`.

This document records, for each of the six flows converted in Phase 2, the source flow file, the fragments consulted, the role sequence chosen in the runbook, the HITL gates mapped, and every intentional divergence from the legacy flow runtime's observable behavior.

The Phase 2 goal is to translate the six existing flows into linear runbooks that the `lead-mode.ts` planner can execute under `CANON_AGENT_TEAMS_MODE=on`. The translation is a compromise: the legacy flow runtime is a state machine with loops, branches, convergence gates, and adaptive fragments; the runbook format is a linear list of teammate spawns with a single Phase 2 extension (`wave: true`). Where the two formats disagree, the notes below call out the divergence and the rationale for either modelling it with existing primitives or deferring it to Phase 3.

---

## Common compromises (all wave runbooks)

Before the per-flow sections, a handful of divergences apply to every runbook that contains a wave:

- **Plan index path.** The legacy flow runtime writes its wave plan index to `plans/<slug>/INDEX.md` (see `mcp-server/src/features/orchestration/tools/write-plan-index.ts`). Phase 2 runbooks write the architect's plan index to the flat `plans/INDEX.md` path. This is an intentional simplification of the runbook schema — the single optional `wave: true` field stays simple at the cost of a one-file observable drift from legacy. The downstream wave implementors still land at `plans/<slug>/<task_id>-SUMMARY.md`, matching the legacy convention exactly.

- **Fan-in via glob paths.** A linear runbook cannot enumerate N per-task paths in a single upstream reference. Phase 2 resolves flat downstream steps that reference a wave-produced artifact by synthesizing a glob-shaped upstream path: `plans/<slug>/*-SUMMARY.md`. The tester, scribe, reviewer, and shipper steps receive this glob in their spawn prompts and are expected to discover the matching per-task files at runtime. Legacy Canon hands the downstream agent an aggregated `wave_summaries` block; the runbook format does not model that, so the glob is the compromise.

- **Loops are flattened.** The legacy `review-fix-loop`, `verify-fix-loop`, and `security-fix-loop` fragments run a review/verify/scan step, branch to a fixer on failure, and loop back. The runbook format does not support loops. Phase 2 runbooks replace these loops with a single review/verify/scan step gated by `hitl: after_if_verdict_not_clean`. A non-clean verdict pauses for the user to triage rather than auto-spawning a fixer. The fixer role is not invoked at all by Phase 2 runbooks; if a user explicitly asks Canon to fix the findings, they launch a follow-up flow.

- **User-checkpoint fragment.** Legacy flows that include `user-checkpoint` spawn `canon-guide` between the architect and implementor to summarize the plan and wait for user feedback, with the loop returning to `design` on `revise`. Runbooks model this as `hitl: after` on the architect step. The `canon-guide` spawn and the revision loop are not replicated — the user's HITL breakpoint is surfaced via the runbook HITL mechanism, which pauses the team lead with the architect's plan for direct review.

- **Pre-launch-check and learn steps.** Legacy `pre-launch-check` is a gate-only state (no agent) that runs discovered quality-check commands, and `ship-done.md` concludes with an optional `canon-learner` invocation. Neither is currently expressible in the runbook format. Phase 2 runbooks end at the `canon-shipper` step; the pre-launch gate and the learner step are out of scope and documented here as punted to Phase 3.

- **Task ids are supplied at plan time.** Legacy Canon's architect authors the plan index and the wave runtime reads the task ids from it to drive the wave. Phase 2's static wave support requires the caller to pass `wave_context.task_ids` to `planRun` up front. The smoke-test harness seeds three synthetic task ids per wave; real lead-mode execution will need either an earlier parsing pass over the architect's output or a human-supplied list. This is the single biggest Phase 2 punt — adaptive replanning where the architect's output drives the next wave's shape is Phase 3.

---

## feature

Source flow: `flows/feature.md`
Fragments consulted: `user-checkpoint`, `context-sync`, `verify-fix-loop`, `review-fix-loop`, `pre-launch-check`, `ship-done`
Runbook: `skills/canon/runbooks/feature.yaml` (tier: medium)

Role sequence:
1. `canon-researcher` (flat) — feature scope research. **Added step** not present in the legacy flow, which enters directly at `design`. The runbook prepends a researcher to give the architect upstream context and to match the medium-tier shape of refactor and migrate.
2. `canon-architect` (flat, `hitl: after`) — plan index. Mirrors legacy `design.approval_gate: true` and the `user-checkpoint` fragment.
3. `canon-implementor` (wave) — one teammate per task id in the plan index. Matches legacy `implement.type: wave`.
4. `canon-tester` (flat) — runs the suite against the wave output. Mirrors `verify-fix-loop.verify`.
5. `canon-scribe` (flat) — mirrors `context-sync`.
6. `canon-reviewer` (flat, `hitl: after_if_verdict_not_clean`) — mirrors `review-fix-loop.review`.
7. `canon-shipper` (flat) — mirrors `ship-done.ship`.

Divergences:
- Researcher step prepended (see above).
- `verify-fix-loop` and `review-fix-loop` collapsed to single review/test steps with verdict-gated HITL. The legacy `fix-impl` and `fix-violations` loops are not replicated.
- `pre-launch-check` and `learn` states omitted.
- The `checkpoint` sub-state (canon-guide) is not spawned; HITL is presented on the architect step instead.
- Architect's plan index path diverges from `plans/<slug>/INDEX.md` to `plans/INDEX.md` per the common compromise above.

Gaps punted to Phase 3:
- Adaptive wave planning from the architect's plan index output.
- Loop-and-fix behaviors (`fix-impl`, `fix-violations`).
- Pre-launch gate execution and the learner step.
- The user-checkpoint revision cycle.

---

## refactor

Source flow: `flows/refactor.md`
Fragments consulted: `user-checkpoint`, `verify-fix-loop`, `context-sync`, `review-fix-loop`, `pre-launch-check`, `ship-done`
Runbook: `skills/canon/runbooks/refactor.yaml` (tier: medium)

Role sequence:
1. `canon-researcher` (`task_type: refactor`) — refactor scope analysis. Mirrors legacy `analyze.role: refactor-scope`.
2. `canon-architect` (`hitl: after`) — plan index. **Not present in the legacy refactor flow**, which jumps directly from `analyze` to `implement`. Phase 2 adds an explicit architect step because the wave implementor needs an explicit plan-index upstream — the legacy flow must be implicitly synthesizing task ids somewhere in its wave runtime, but the runbook format requires the plan to be authored by a named step. Documented as an additive divergence rather than a behavior change.
3. `canon-implementor` (wave, `task_type: refactor`) — one teammate per refactor task id.
4. `canon-tester` (flat) — mirrors `verify-fix-loop.verify`.
5. `canon-scribe` (flat) — mirrors `context-sync`.
6. `canon-reviewer` (flat, `hitl: after_if_verdict_not_clean`) — mirrors `review-fix-loop.review`, with `max_iterations: 2` from the legacy flow's `with:` block dropped.
7. `canon-shipper` (flat) — mirrors `ship-done.ship`.

Divergences:
- Architect step inserted (see above).
- Same loop/fix/checkpoint/pre-launch compromises as `feature`.
- `task_type: refactor` selects the new Phase 2 task-type tag in the spawn module.

Gaps punted to Phase 3:
- Same set as `feature` plus: the legacy `refactor.implement.gate: test-suite` gate is not modeled by the runbook format — Phase 2 leaves gate execution to the tester step.

---

## migrate

Source flow: `flows/migrate.md`
Fragments consulted: `user-checkpoint`, `verify-fix-loop`, `security-scan`, `context-sync`, `review-fix-loop`, `pre-launch-check`, `ship-done`
Runbook: `skills/canon/runbooks/migrate.yaml` (tier: medium)

Role sequence:
1. `canon-researcher` (`task_type: migrate`) — migration scope + rollback. **Compressed from two legacy researcher spawns** — legacy uses `research.type: parallel` with roles `[migration-scope, rollback-plan]`. Phase 2 runs a single researcher; the task_type + role brief are expected to guide it to cover both concerns in one synthesis.
2. `canon-architect` (`task_type: migrate`, `hitl: after`) — staged migration plan. **Compressed from two legacy architect spawns** — legacy uses `design.compete.count: 2` with `strategy: synthesize` and `lenses: [safety-first, minimal-disruption]`. Phase 2 runs a single architect; the task_type `migrate` is expected to select priming that balances safety and minimal disruption.
3. `canon-implementor` (wave, `task_type: migrate`) — one teammate per migration stage.
4. `canon-tester` (flat) — verifies each stage.
5. `canon-security` (flat, `task_type: security-audit`, `hitl: after_if_verdict_not_clean`) — audits migration surface. Mirrors `security-scan.security`.
6. `canon-scribe` (flat) — mirrors `context-sync`.
7. `canon-reviewer` (flat, `hitl: after_if_verdict_not_clean`) — mirrors `review-fix-loop.review`.
8. `canon-shipper` (flat) — mirrors `ship-done.ship`.

Divergences:
- Parallel research and competitive design collapsed to single spawns (see above).
- The legacy `security-scan.on_critical: fix-security` loop is replaced with HITL on non-clean verdict.
- Same general compromises as `feature`.

Gaps punted to Phase 3:
- Competitive design (`compete.count`, `strategy: synthesize`, lenses).
- Parallel researcher with distinct roles.
- The `fix-security` parallel-per loop.
- Same general gap set as `feature`.

---

## test-gap

Source flow: `flows/test-gap.md`
Fragments consulted: `review-fix-loop`
Runbook: `skills/canon/runbooks/test-gap.yaml` (tier: small)

Role sequence:
1. `canon-researcher` (`task_type: test-gap`) — coverage scan. Mirrors legacy `scan.role: coverage-scan`.
2. `canon-tester` (`task_type: test-gap`) — write tests and run the suite. Mirrors legacy `write-tests`.
3. `canon-reviewer` (`hitl: after_if_verdict_not_clean`) — principle review. Mirrors `review-fix-loop.review`.

Divergences:
- Legacy `write-tests` has `max_iterations: 2` and `stuck_when: same_file_test`. Runbook cannot model iteration caps.
- Legacy `write-tests → implementation_issue → fix-impl → write-tests` loop is removed. A failing tester verdict is surfaced as HITL instead of auto-spawning `canon-fixer`.
- Legacy `scan → no_gaps → done` short-circuit is removed. The runbook always runs all three steps; if the researcher reports no gaps, the tester and reviewer still run and produce trivial artifacts.
- Same observable-behavior divergence as `review-only` / `security-audit` on artifact paths: test report lands at `reviews/TEST-REPORT.md` (flat) rather than the legacy `plans/<slug>/TEST-REPORT.md`.

Gaps punted to Phase 3:
- The no-gaps short-circuit.
- The test-fix loop.
- The iteration + stuck-detection policy on the tester.

---

## review-only

Source flow: `flows/review-only.md`
Fragments consulted: none
Runbook: `skills/canon/runbooks/review-only.yaml` (tier: small)

Role sequence:
1. `canon-reviewer` (`hitl: after_if_verdict_not_clean`) — single-pass diff review.

Divergences:
- Legacy `review-only.review` has `large_diff_threshold: 300` and `cluster_by: layer`. The legacy runtime fans out into per-layer reviewer instances when the diff exceeds the threshold; the runbook format cannot model this condition. Phase 2 runs a single reviewer regardless of diff size. This is a meaningful observable divergence for large PRs — users running review-only on very large diffs should be aware.
- Legacy artifacts landed at `plans/<slug>/REVIEW.md` and `reviews/REVIEW.md`; Phase 2 writes only the flat `reviews/REVIEW.md`.

Gaps punted to Phase 3:
- Conditional auto-fanout for large diffs.

---

## security-audit

Source flow: `flows/security-audit.md`
Fragments consulted: `security-scan`
Runbook: `skills/canon/runbooks/security-audit.yaml` (tier: small)

Role sequence:
1. `canon-security` (`task_type: security-audit`, `hitl: after_if_verdict_not_clean`) — scan for vulnerabilities.
2. `canon-reviewer` (`hitl: after_if_verdict_not_clean`) — principle compliance review, cross-referencing the security assessment.

Divergences:
- Legacy `security-scan.on_critical` sends critical findings into a `fix-security` parallel-per loop with `fix_max_iterations: 2`. Phase 2 replaces this with HITL on non-clean verdict; the user triages and launches a follow-up flow if fixes are needed.
- Artifact paths flattened from `plans/<slug>/SECURITY.md` + `plans/<slug>/REVIEW.md` to `reviews/SECURITY.md` + `reviews/REVIEW.md`.

Gaps punted to Phase 3:
- The `fix-security` auto-loop.

---

## Things Phase 2 did NOT attempt

Deliberate out-of-scope items, tracked so Phase 3 knows what to pick up:

1. **Adaptive wave planning.** The architect's plan-index output cannot drive the next wave's shape. Callers must supply `wave_context.task_ids` at plan time.
2. **Branching and conditional transitions.** The runbook is strictly linear. Verdict outcomes surface as HITL, not as runbook-level control flow.
3. **Auto-fix loops.** `review-fix-loop`, `verify-fix-loop`, and `security-scan` fix-loops are all collapsed to HITL.
4. **Iteration caps and stuck detection.** `max_iterations`, `stuck_when`, and convergence gates have no runbook counterpart.
5. **Competitive flows and debates.** `compete.count`, `strategy: synthesize`, lenses, and the debate protocol are not represented.
6. **Parallel researchers / parallel-per fix steps.** Multi-role parallel spawning is flattened to single spawns; wave is the only fan-out primitive.
7. **Gate-only states** (`pre-launch-check`). Deterministic quality-check execution is deferred.
8. **The learner step.** `canon-learner` is never spawned by Phase 2 runbooks.
9. **Skip conditions** (`skip_when: no_contract_changes`, `skip_when: auto_approved`, `skip_when: learn_gate_not_passed`). Runbook steps always run.
10. **Post-state effects** (`effects: [check_postconditions]`). Legacy Canon runs contract-checker assertions after a state completes — the `feature.implement` wave state is the main user. Runbooks have no post-step effect hook; the equivalent enforcement must be embedded in the agent's instructions or surface as a separate step.
11. **Inter-wave gates** (`gate: test-suite` on `refactor.implement` and `migrate.implement`). Legacy Canon runs a shell gate between waves; runbooks have no inter-step gate primitive. Gates are deferred to a dedicated tester step that runs after the wave completes.

All eleven items are valid Phase 3 schema extensions. They are documented here so that when Phase 3 begins with epic-flow adaptive waves, the full punt list is visible to whoever designs the extended schema.

---

## Drift vs. legacy runtime

Stretch-goal cross-check. Each Phase 2 runbook was planned via `loadAndPlan` and the corresponding legacy flow was walked via `simulate_flow` with a happy-path scenario. The diff below is a sanity check, not a correctness gate — the runbook format is linear and the flow format is a state machine with loops, so some divergence is expected. The drift script that produced this table is in the session record, not committed to the repo.

Summary of role-set diffs (legacy vs runbook, on happy-path scenarios):

| Flow             | Shared roles                                                                                                 | Legacy only                        | Runbook only           | Notes                                                                                                                                    |
|------------------|--------------------------------------------------------------------------------------------------------------|------------------------------------|------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `feature`        | architect, implementor, reviewer, scribe, shipper, tester                                                    | `canon-learner`                    | `canon-researcher`     | Runbook prepends a researcher step (documented in §feature). Learner punt is per the common compromise list.                             |
| `refactor`       | implementor, researcher, reviewer, scribe, shipper, tester                                                   | `canon-guide`, `canon-learner`     | `canon-architect`      | Runbook adds explicit architect step (documented in §refactor). Guide is the user-checkpoint collapse; learner is punted.                 |
| `migrate`        | architect, implementor, researcher, reviewer, scribe, security, shipper, tester                              | `canon-guide`, `canon-learner`     | (none)                 | Parallel researcher and competitive architect are compressed to single spawns in §migrate. Guide/learner compromises as above.           |
| `test-gap`       | researcher, reviewer, tester                                                                                 | (none)                             | (none)                 | **Exact match** on happy path. Only divergences (no_gaps short-circuit, fix-impl loop) live on non-happy scenarios.                      |
| `review-only`    | reviewer                                                                                                     | (none)                             | (none)                 | **Exact match** on happy path. The large-diff auto-fanout divergence (§review-only) only triggers on `diff > 300` lines.                 |
| `security-audit` | reviewer                                                                                                     | (none)                             | `canon-security`       | The legacy `flows/security-audit.md` file declares no `entry:` field, so the parser defaults to `review`, leaving the `security` and `fix-security` states from the `security-scan` fragment unreachable. The Phase 2 runbook runs `canon-security` first and is arguably more correct than legacy. The legacy flow raises two flow-parser warnings ("state 'security' is unreachable from entry 'review'") on every load. |

### Interpretation

- **Every Phase 2 divergence from legacy is already documented in a per-flow section above.** No surprises surfaced in the cross-check.
- **`test-gap` and `review-only` are exact role-set matches on the happy path.** The only divergences for those two flows are branch-reachable states (`no_gaps`, `fix-impl`, the large-diff auto-fanout) that do not appear on the happy-path scenarios, and they are all documented in their per-flow sections.
- **`feature` / `refactor` / `migrate` shed `canon-guide` and `canon-learner`** via the common-compromise collapses (user-checkpoint → runbook HITL; learner step → punted). Each also either adds or removes a role relative to legacy, all intentional.
- **The `security-audit` anomaly** is not a Phase 2 regression — it is a pre-existing bug in `flows/security-audit.md` where the missing `entry:` field causes the legacy parser to pick `review` as the entry state and leave the `security-scan` fragment states unreachable. The Phase 2 runbook happens to correct this by running the security step first. Phase 2 does NOT patch the legacy flow file (out of scope per the hard rules), but a reviewer should note that a user running the legacy `security-audit` flow today is only getting a principle-compliance review, not a security scan.
- The `simulate_flow` tool emits `wave`/`parallel`/`skip_when` warnings as expected on `feature` (`implement` wave, `context-sync` skip), `refactor` (`checkpoint`/`implement`/`context-sync`/`learn`), and `migrate` (`research` parallel, `checkpoint`/`implement`/`context-sync`/`learn` skip). None of these reflect drift — they are noise from the simulator's "simulated as single step" policy.

### Conclusion

No undocumented drift. Every legacy-only and runbook-only role in the table lines up with an already-explained compromise or punt earlier in this document. The one unexpected finding — the legacy `security-audit` entry-state bug — is a pre-existing issue in the legacy flow file that is explicitly out of Phase 2 scope and is flagged here for a human reviewer to decide whether to file separately.
