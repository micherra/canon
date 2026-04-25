---
task_id: "v2_1b-02"
wave: 3
depends_on: ["v2_1b-01"]
decisions:
  - "dc-03"
files:
  - hooks/canon-agent-teams/completion-verify.sh
principles:
  - agent-surface-assumptions
domains:
  - infrastructure
---

## Task: Extend `completion-verify.sh` to call `snapshot_workspace`

### Action

Amend `hooks/canon-agent-teams/completion-verify.sh` (from v2 phase1-07) so that after `verify_completion` clears, the hook calls `snapshot_workspace({ workspace_id })` (from v2_1b-01). Snapshot failure blocks flow completion — the hook exits non-zero and surfaces the error.

**Amendment structure:**

```
# (existing) verify_completion stage
if ! verify_completion ...; then
  echo "verify_completion failed"; exit 2
fi

# (new, v2.1b) snapshot stage
if ! snapshot_workspace "$WORKSPACE_ID"; then
  echo "snapshot_workspace failed for $WORKSPACE_ID"; exit 2
fi
```

**Ordering:** verify must clear before snapshot attempts. Rationale:
- verify enforces artifact + step completeness; snapshot reads that completeness into `total_steps_executed` etc.
- Snapshotting an incomplete workspace produces misleading lifecycle data

**Failure handling:**

- `verify_completion` fails → exit 2 (existing behavior); no snapshot attempted
- `verify_completion` clears, `snapshot_workspace` fails → exit 2 with snapshot-specific message; workspace is NOT torn down by downstream cleanup (janitor retries later)
- Both succeed → hook exits 0; workspace may now be safely torn down

**Janitor behavior:** per v2.1 §8.2, janitor processes call `snapshot_workspace` before deleting abandoned workspaces. That path is separate from this hook (janitor has its own code path), but both use the same tool.

### Canon principles to apply

- **agent-surface-assumptions** — hook failure mode is explicit: "verify must clear before snapshot; snapshot failure blocks teardown"

### Risk mitigations

- MEDIUM-5 (workspace-vs-DB boundary): hook is the materialization boundary; this task makes that boundary hard and enforceable
- Orchestration journal SPoF (MEDIUM-3): snapshot produces a durable record; if the journal is sparse, the snapshot reflects that, giving the learner visibility into data-quality issues

### Tests to write

- `hooks/canon-agent-teams/__tests__/completion-verify.test.sh`:
  - Happy path: complete workspace → verify clears → snapshot writes row → hook exits 0
  - verify_completion fails → hook exits 2; snapshot NOT attempted
  - verify clears, snapshot fails → hook exits 2 with snapshot error message; workspace not torn down by downstream
  - Idempotency: re-run of hook against the same workspace does not create duplicate snapshot rows (delegates to v2_1b-01 idempotency)
- Integration (from v2_1b-08):
  - Full flow: planner synth → execute → completion-verify → snapshot row exists → workspace torn down

### Verify

1. Hook script extended with snapshot call
2. Error-handling / exit codes preserved across both stages
3. Unit tests pass
4. Integration test passes (runs in v2_1b-08 validation)

### Done when

- Hook extension merged
- Tests pass
- v2_1b-01 snapshot_workspace tool invokable from the hook environment (env vars, MCP access, etc. all resolved)
- Janitor path noted as follow-up (separate from this task — janitor's snapshot call is covered by v2_1b-01 tool's idempotency, not by a separate hook change)
