---
task_id: "v2_1a-07"
wave: 4
depends_on: ["v2_1a-03", "v2_1a-04", "v2_1a-05", "v2_1a-06"]
decisions:
  - "dc-08"
files:
  - docs/v2.1a-coldstart-spike.md
principles:
  - agent-evidence-over-intuition
  - agent-surface-assumptions
domains:
  - infrastructure
  - testing
---

## Task: Pre-ship cold-start friction spike (review MEDIUM-6)

### Action

Run a pre-ship spike to measure cold-start iteration-0 latency for trivial requests under the iterate-until-approved model. Document the measurement methodology, raw numbers, and pass/fail decision in `docs/v2.1a-coldstart-spike.md`. This is the architect-review MEDIUM-6 resolution and the v2.1a exit criterion dc-08.

**Purpose.** The iterate-until-approved design (v2.1 §6) trades a synchronous planner round-trip for a learning-loop-capable plan corpus. The cold-start period — when `memory: project` is empty and no corpus anchoring exists — is the friction peak. If cold-start is intolerable, the design needs mitigation before Wave 1 of v2.1a ships to production.

**Methodology:**

1. **Three representative trivial requests:**
   - Request 1: "Fix the typo in `docs/reference/canon-reference.md` where 'relevent' should be 'relevant'"
   - Request 2: "Rename the constant `EMBEDDING_BATCH_SIZE` to `EMBEDDING_CHUNK_SIZE` in `mcp-server/src/shared/constants.ts` and update its callers" *(amended: original referenced non-existent `src/shared/util/foo.ts`)*
   - Request 3: "Update the default value of `max_principles_per_review` in `.canon/config.json` from 10 to 15" *(amended: original referenced non-existent `CANON_DEFAULT_TIMEOUT_MS` key)*
2. **Measurement:**
   - Start a fresh session with `CANON_AGENT_TEAMS_MODE=on`, empty planner memory, no corpus
   - Submit the request
   - Measure wall-clock time from user submission to the moment the lead presents the planner's brief + runbook
   - Record: time-to-first-proposal, number of planner tool calls, total tokens consumed, user-perceived friction (subjective note)
   - Repeat each request 3 times (fresh memory between) to capture variance
3. **Target:** iteration-0 time-to-first-proposal ≤ 20 seconds for each trivial request. Rationale: user patience for "thinking" before action is roughly 15–30 seconds; 20s is a conservative upper bound.
4. **Pass/fail decision:**
   - **PASS** if all 9 measurements (3 requests × 3 reps) are within target
   - **CONDITIONAL PASS** if 7/9 or 8/9 are within target — note the outliers and whether they correlate with a measurable variable (KG staleness, network, etc.); pass if variance is explainable
   - **FAIL** if < 7/9 within target, or variance is unexplainable. Pause v2.1a rollout, revisit the lightweight-proposal path (v2.1 §6.2), and design a mitigation before shipping

### Canon principles to apply

- **agent-evidence-over-intuition** — spike produces measurements, not assertions; decision is grounded in wall-clock data
- **agent-surface-assumptions** — the target (20s) is explicit; if the spike rejects, the rejection criterion is also explicit

### Risk mitigations

- Cold-start iterate-until-approved friction (review MEDIUM-6 — the downgraded former HIGH-2): this spike is the mitigation
- Planner inconsistency (§13 risk): the three requests are different shapes; if planner latency varies wildly by request shape, that is itself a signal worth recording

### Tests to write

This is the test. The spike report IS the deliverable.

### Verify

1. `docs/v2.1a-coldstart-spike.md` exists with methodology, raw measurements, pass/fail decision, and §11 target revision
2. All 9 measurements recorded (original spike §2 + mitigation re-run §10)
3. Pass decision documented against revised targets (30s median REDIRECT / 60s median GREENLIGHT — see spike report §10 for architectural-floor rationale) and cross-referenced from `docs/agent-teams-migration-plan-v2.md` §10.2 exit criteria
4. v2.1b planner-efficiency follow-up filed (`.canon/workspaces/agent-teams-v2/plans/v2_1b/v2_1b-09-PLAN.md`)

### Done when

- Spike report committed with original measurements (§2), mitigation re-run (§10), and target revision (§11)
- Verdict: CONDITIONAL PASS under revised targets (7/9 within 30s REDIRECT / 60s GREENLIGHT)
- v2_1a-07-fix (Wave 4.5) applied: worktree isolation skipped for plan-mode agents, cold-start KG awareness added
- v2.1b planner-efficiency follow-up filed for further cold-start floor reduction (v2_1b-09)
- v2.1a Wave 5 (v2_1a-08 cross-artifact validation) proceeds with revised targets as the acceptance bar
