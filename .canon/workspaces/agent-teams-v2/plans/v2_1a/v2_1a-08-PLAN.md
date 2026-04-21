---
task_id: "v2_1a-08"
wave: 5
depends_on: ["v2_1a-07"]
decisions:
  - "dc-09"
files:
  - docs/v2.1a-validation-report.md
principles:
  - agent-evidence-over-intuition
domains:
  - infrastructure
  - testing
---

## Task: v2.1a cross-artifact validation

### Action

Run end-to-end validation of v2.1a against ≥ 5 distinct request types. Document results in `docs/v2.1a-validation-report.md`. This satisfies dc-09 and is the v2.1a exit criterion before entry to v2.1b.

**5 request types to exercise:**

1. **Bug fix** (trivial) — 1-step runbook; demonstrates lightweight-proposal path (§6.2)
2. **Small feature** — 3–4 step runbook: `design` → `implement` → `verify` → mandatory tail
3. **Refactor** (behavior-preserving) — `implement` → `verify` (no behavior changes) → mandatory tail
4. **Migration** — `research` → `design` → `migrate` (with paired rollback artifact) → `verify` → `security` → `review` → mandatory tail
5. **Test-gap fill** — `research` → `test` → mandatory tail (no `ship` step)

**For each request type, validate:**

1. **Synthesis contract upheld** (runs integration tests from v2_1a-02): mandatory tail present; only canonical step IDs; `skills:` names resolve; contract pairings applied where relevant
2. **Iterate-until-approved works**: user can request iteration; planner re-spawns with context; intermediate runbooks persist at `runbook-iter-N.md`
3. **Approved runbook executes**: lead logs each step via `log_step`; artifacts land at declared paths; per-step `outcome` recorded
4. **L1 observed**: a deliberate chat-then-pivot scenario routes the build request through planner
5. **L4 observed**: an attempt to edit a tracked file without an active workspace is blocked with an actionable message; edit of a gitignored file succeeds; edit of a tracked file with an active workspace succeeds
6. **Intent routing (v2_1a-06) works**: `canon-writer` spawn against a principle edit creates a workspace; L4 does not block
7. **Artifact quality parity**: compare outputs to baseline v2-era static-runbook outputs for equivalent flows — no regression in review verdict, test coverage, or implementation summary structure

**Report structure:**

- Executive summary (pass / conditional pass / fail)
- Per-request-type section with: request text, synthesized runbook (brief summary), execution log, artifacts produced, validation checks passed, deviations noted
- L1 observation section
- L4 observation section (include a false-positive test matrix per v2_1a-05 integration tests)
- Intent-routing observation section (canon-writer + canon-learner runs)
- Quality-parity comparison table (v2.1a output vs. v2 baseline for equivalent flow types)
- Regression summary (flag off → behavior unchanged)
- Open issues / follow-ups (if any)

**Exit decision:**

- **PASS** — all 5 request types complete end-to-end with synthesis contract upheld; L1 + L4 observed; intent routing works; no artifact-quality regression. v2.1a is shipped; v2.1b may begin once ≥ 20 real-use synthesized runbooks accrue
- **CONDITIONAL PASS** — 4/5 request types pass; flagged issues documented; decision on whether to proceed escalated to Canon maintainer
- **FAIL** — any of: synthesis contract violations across multiple request types; L1/L4 false positives; intent-routing false positives; material artifact-quality regression. v2.1a rollout paused; failures triaged and fix tasks added before re-run

### Canon principles to apply

- **agent-evidence-over-intuition** — the validation report is evidence for the Wave-5 exit decision

### Risk mitigations

- All §13 v2.1-specific risks get checked here
- Review HIGH-1 resolution confirmed (intent routing + L4 work together without false positives)
- Review MEDIUM-6 resolution confirmed (spike from v2_1a-07 passed; steady-state expectations calibrated)

### Tests to write

No new automated tests. This task runs the existing integration test suite against real scenarios and records outcomes. Any new automated tests that fall out of the validation (e.g., a specific false-positive L4 scenario that needs a regression test) are filed as follow-up tasks, not inline.

### Verify

1. `docs/v2.1a-validation-report.md` exists and covers all 5 request types
2. L1, L4, and intent-routing observations documented
3. Quality-parity table populated
4. Exit decision (PASS / CONDITIONAL PASS / FAIL) justified against per-request pass criteria
5. Report cross-referenced from `docs/agent-teams-migration-plan-v2.md` §10.2 exit criteria

### Done when

- Report committed
- Exit decision is PASS or CONDITIONAL PASS (FAIL blocks v2.1b entry)
- Any follow-up tasks filed
- v2.1a entry gate (≥ 20 real-use synthesized runbooks) monitoring begins
