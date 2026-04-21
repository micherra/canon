---
task_id: "v2_1b-01"
wave: 2
depends_on: ["v2_1b-00"]
decisions:
  - "dc-02"
files:
  - mcp-server/src/features/diagnostics/tools/snapshot-workspace.ts
  - mcp-server/src/app/register-diagnostics.ts
principles:
  - agent-surface-assumptions
  - agent-evidence-over-intuition
domains:
  - backend-api
  - backend-data
---

## Task: `snapshot_workspace` MCP tool

### Action

Implement the `snapshot_workspace({ workspace_id }) → { snapshot_id }` MCP tool per v2.1 §8.3 and `docs/agent-teams-migration-plan-v2.md` §8.3. The tool reads a workspace's state and writes one row to `lifecycle_workspace_snapshots` (v2_1b-00).

**Signature:**

```ts
snapshot_workspace({ workspace_id: string }) → { snapshot_id: number }
```

**Behavior:**

1. Resolve workspace path from `workspace_id` (use existing Canon conventions — workspace IDs map to `.canon/workspaces/<slug>/` or equivalent)
2. Read workspace state:
   - `slug` — from workspace metadata / directory name
   - `outcome` — infer from workspace state: `'complete'` if `board.json` marks the flow as complete; `'aborted'` if explicitly aborted; `'abandoned'` if janitor is snapshotting a stale workspace
   - `total_iterations_to_approve` — count of `runbook-iter-N.md` files in `${WORKSPACE}/plans/${slug}/` (v2.1a persistence convention) plus 1 for the approved runbook; `1` if no iteration files (single-shot approval)
   - `total_steps_executed` — count from the orchestration journal `log_step` entries with `status: "completed"`
   - `total_steps_skipped` — count from the journal with `status: "skipped"`
   - `total_hitl_events` — count from the journal or an HITL log (v2.1b scope: use journal-derived count; proper HITL-event table is v2.2)
   - `total_deviations` — count of `justified_deviations[]` entries across all implementation-summary files in `${WORKSPACE}/plans/${slug}/` (v2_1b-04 populates these)
   - `flow_duration_ms` — `snapshotted_at - first_log_step_timestamp`
   - `commit_range_first` / `commit_range_last` — from git log scoped to the workspace's branch or the workspace-associated worktree
   - `snapshotted_at` — `Date.now()` at snapshot time
   - `approved_runbook_id` — always `NULL` in v2.1b (no `lifecycle_synthesized_runbooks` table yet)
3. Insert one row into `lifecycle_workspace_snapshots`
4. Return `{ snapshot_id: <inserted row id> }`

**Idempotency:** enforced at the schema layer via `UNIQUE(workspace_id)` on `lifecycle_workspace_snapshots` (v2_1b-00 DDL). Tool implementation uses atomic upsert:

```sql
INSERT INTO lifecycle_workspace_snapshots (
  workspace_id, slug, approved_runbook_id, outcome,
  total_iterations_to_approve, total_steps_executed, total_steps_skipped,
  total_hitl_events, total_deviations, flow_duration_ms,
  commit_range_first, commit_range_last, snapshotted_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
  slug = excluded.slug,
  approved_runbook_id = excluded.approved_runbook_id,
  outcome = excluded.outcome,
  total_iterations_to_approve = excluded.total_iterations_to_approve,
  total_steps_executed = excluded.total_steps_executed,
  total_steps_skipped = excluded.total_steps_skipped,
  total_hitl_events = excluded.total_hitl_events,
  total_deviations = excluded.total_deviations,
  flow_duration_ms = excluded.flow_duration_ms,
  commit_range_first = excluded.commit_range_first,
  commit_range_last = excluded.commit_range_last,
  snapshotted_at = excluded.snapshotted_at
RETURNING id;
```

Returns the row id regardless of whether insert or update happened. Safe under concurrent hook + janitor calls because the UNIQUE constraint + ON CONFLICT clause are atomic at the SQLite level.

**Failure modes:**

- Workspace not found → return MCP error "Workspace not found: {workspace_id}"
- DB write fails → surface the error (do not silently drop)
- Partial state (e.g., workspace was torn down before snapshot) → populate with best-effort values; set `outcome: 'abandoned'` if state is incoherent; log the partiality

**Registration:** register the tool in `mcp-server/src/app/register-diagnostics.ts` (or the equivalent registration module for lifecycle-adjacent tools). Tool is available unconditionally — snapshot is the successor to artifact-on-disk-only; it should work regardless of feature flag state.

**Return shape (v2.1b):** minimal — `{ snapshot_id }`. v2.2 may expand to `{ snapshot_id, runbook_id, deviations_detected }` when additional tables exist; v2.1b consumers (hook, janitor) don't need the expanded shape.

### Canon principles to apply

- **agent-surface-assumptions** — `approved_runbook_id: NULL` in v2.1b is deliberate, not a defect; document in tool docstring
- **agent-evidence-over-intuition** — every snapshot field is populated from measurable workspace state; no inferred or default-fallback values without logging

### Risk mitigations

- Orchestration journal SPoF (review MEDIUM-3 / §13): snapshot reading journal state surfaces missing entries — if `total_steps_executed` is 0 while `outcome: 'complete'`, that's a data-quality alarm the learner can detect later
- MEDIUM-5 (workspace-vs-DB truth boundary): this tool is the materialization boundary; tool docstring explicitly states "workspace is source of truth before snapshot; DB is source of truth after"

### Tests to write

- `mcp-server/src/features/diagnostics/tools/__tests__/snapshot-workspace.test.ts`:
  - Happy path: complete workspace → row written with expected fields
  - Idempotent: second call with same workspace_id updates existing row
  - Workspace not found → returns MCP error
  - Partial state: workspace with no journal entries → `total_steps_executed: 0`, logs warning
  - Aborted workspace → `outcome: 'aborted'`
  - Abandoned workspace (janitor call) → `outcome: 'abandoned'`
  - `approved_runbook_id` is `NULL` for all v2.1b snapshots
- Integration test:
  - End-to-end: run a short flow → complete → hook (v2_1b-02) calls `snapshot_workspace` → row exists

### Verify

1. Tool file exists at `mcp-server/src/features/diagnostics/tools/snapshot-workspace.ts`
2. Tool registered and invokable via MCP
3. `npm run build` passes
4. `npm test -- snapshot-workspace` passes
5. Integration: complete a flow, confirm row in `lifecycle_workspace_snapshots`

### Done when

- Tool implemented, registered, tested
- Idempotency + failure-mode coverage verified
- v2_1b-02 (completion-verify hook extension) can call this tool without scaffolding
