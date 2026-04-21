---
task_id: "v2_1b-08"
wave: 6
depends_on: ["v2_1b-07"]
decisions:
  - "dc-09"
files:
  - docs/v2.1b-validation-report.md
principles:
  - agent-evidence-over-intuition
domains:
  - infrastructure
  - testing
---

## Task: v2.1b cross-artifact validation

### Action

Run end-to-end validation of the complete v2.1b substrate and document in `docs/v2.1b-validation-report.md`. This satisfies dc-09 and is v2.1b's exit criterion before ratification. Gate B (v2_1b-07) provides one accepted proposal; this task validates that the entire substrate operates correctly across the full cycle.

**Validation scope:**

1. **Schema layer** (v2_1b-00):
   - `lifecycle_workspace_snapshots` exists in `drift-db.sqlite` on a fresh install
   - Migration is reversible (`down()` tested against a disposable DB)
   - Indexed columns (`slug`, `snapshotted_at`) used by learner queries perform adequately (quick sanity: learner's analysis query completes in < 5s against the accumulated data)

2. **Snapshot layer** (v2_1b-01):
   - Completing a flow triggers a snapshot row
   - Re-running against the same workspace updates (not duplicates) the row
   - Aborted / abandoned workspaces get correct `outcome` values
   - Partial-state workspaces (janitor path) handled without crashes

3. **Hook layer** (v2_1b-02):
   - `completion-verify.sh` calls `snapshot_workspace` after verify clears
   - Snapshot failure blocks teardown
   - Hook exits 0 on full success; exits 2 on either verify or snapshot failure

4. **Tag layer** (v2_1b-03/04/05):
   - Every fix-summary artifact has `cause` + `root_cause_tag` populated
   - Every implementation-summary has `justified_deviations[]` present (empty array if no deviations — field presence, not value)
   - Every review finding has `principle_id` populated (no null rows in drift_store.violations for v2.1b-era reviews)
   - Indexer strictly rejects or warns on missing required tags

5. **Analysis layer** (v2_1b-06):
   - Learner reads lifecycle + tag data; produces structured proposals
   - Proposals under confidence bar → observations (no proposal)
   - Learner writes ONLY to `.canon/proposed-learnings/{timestamp}/` in the analysis phase (scope lock)

6. **Curation + application** (v2_1b-07):
   - Gate B evidence exists and is committed
   - `.canon/learning.jsonl` records accepted + dismissed decisions
   - Applied principle edits are traceable from proposal to commit

**Report structure:**

- Executive summary (pass / conditional pass / fail)
- Per-layer section with pass/fail against the validation scope items above
- Observation: data-quality metrics (e.g., what percentage of v2.1b-era review findings have `principle_id` populated? What percentage of fix summaries have `cause` populated?)
- Observation: loop-closure metrics (how many days from first observation of a pattern to accepted refinement? How many proposals generated / accepted / dismissed in v2.1b's shipped period?)
- Open issues / follow-ups (if any)
- Explicit exit decision

**Exit decision:**

- **PASS** — all 6 layers pass validation; Gate B evidence committed; no data-quality crises. v2.1b is ratified. v2.2 entry becomes possible once the ≥ 3 proposals / ≥ 1 accepted threshold **plus** review MEDIUM-1 quality criterion clear (not this task's concern).
- **CONDITIONAL PASS** — 5/6 layers clean; known issues documented as follow-up tasks; decision to proceed escalated to Canon maintainer
- **FAIL** — schema / snapshot / hook failures; substrate is not production-ready. v2.1b ratification paused.

### Canon principles to apply

- **agent-evidence-over-intuition** — validation report is evidence, not assertion; every claim maps to a specific test run or data-quality metric

### Risk mitigations

- Observation tag compliance (§13 LOW/LOW): validation surfaces population gaps as data-quality metrics
- Learner expands write scope too aggressively (§13 MEDIUM/LOW): validation confirms scope lock (proposals target only principles)
- MEDIUM-5 (workspace-vs-DB boundary): validation exercises the boundary explicitly via the hook layer

### Tests to write

No new automated tests. Runs existing test suites + curated scenarios. Any failures become remediation tasks.

### Verify

1. `docs/v2.1b-validation-report.md` exists with all sections
2. Per-layer pass/fail clearly stated
3. Data-quality metrics populated (not "TBD")
4. Exit decision justified against measured evidence

### Done when

- Report committed
- Exit decision is PASS or CONDITIONAL PASS
- Cross-referenced from `docs/agent-teams-migration-plan-v2.md` §§10.3, 15.2
- If FAIL: remediation tasks filed; v2.1b ratification paused pending completion
