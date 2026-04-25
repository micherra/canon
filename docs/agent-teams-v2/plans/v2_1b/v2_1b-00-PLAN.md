---
task_id: "v2_1b-00"
wave: 1
depends_on: []
decisions:
  - "dc-01"
files:
  - mcp-server/src/platform/storage/drift/drift-schema.ts
  - mcp-server/src/platform/storage/drift/migrations/NN-lifecycle-workspace-snapshots.ts
principles:
  - agent-design-before-code
  - agent-surface-assumptions
domains:
  - backend-data
  - infrastructure
---

## Task: Add `lifecycle_workspace_snapshots` table migration

### Action

Extend `.canon/drift-db.sqlite` schema with the `lifecycle_workspace_snapshots` table per the SQL DDL in `docs/agent-teams-migration-plan-v2.md` §8.1. Use the existing drift-db migration runner; do NOT create a new DB.

**DDL (exact):**

```sql
CREATE TABLE lifecycle_workspace_snapshots (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE,       -- one snapshot per workspace; enforces v2_1b-01 idempotency
  slug TEXT NOT NULL,
  approved_runbook_id INTEGER,             -- NULL in v2.1b (lifecycle_synthesized_runbooks not yet created)
  outcome TEXT NOT NULL,                    -- 'complete' | 'aborted' | 'abandoned'
  total_iterations_to_approve INTEGER,
  total_steps_executed INTEGER,
  total_steps_skipped INTEGER,
  total_hitl_events INTEGER,
  total_deviations INTEGER,
  flow_duration_ms INTEGER,
  commit_range_first TEXT,
  commit_range_last TEXT,
  snapshotted_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_lifecycle_workspace_snapshots_slug
  ON lifecycle_workspace_snapshots(slug);
CREATE INDEX idx_lifecycle_workspace_snapshots_snapshotted_at
  ON lifecycle_workspace_snapshots(snapshotted_at);
```

**Note on `UNIQUE(workspace_id)`:** v2.md §8.1 DDL did not include this constraint originally; it was added here per fresh-review ISSUE-5. The constraint is the single enforcement of the "one snapshot per workspace" rule v2_1b-01 depends on. Without it, v2_1b-01 would need application-level dedupe via SELECT-then-UPDATE/INSERT — less safe under concurrent hooks + janitor. With it, v2_1b-01 can use `INSERT ... ON CONFLICT(workspace_id) DO UPDATE SET ...` atomically. **Update v2.md §8.1 DDL to match** when that amendment commit lands.

**Implementation:**

1. Locate the existing drift-db migration runner at `mcp-server/src/platform/storage/drift/` (pattern from prior migrations)
2. Create a new migration file `migrations/NN-lifecycle-workspace-snapshots.ts` where NN is the next version number
3. Export `up()` applying the DDL above and `down()` executing `DROP TABLE lifecycle_workspace_snapshots` + `DROP INDEX idx_lifecycle_workspace_snapshots_slug` + `DROP INDEX idx_lifecycle_workspace_snapshots_snapshotted_at`
4. Bump the schema version constant in `drift-schema.ts`
5. Type definition: add the row shape to `drift-schema.ts` (e.g., `LifecycleWorkspaceSnapshotRow` interface with fields matching the DDL)

**Enum values for `outcome`** — values stored must match: `'complete'`, `'aborted'`, `'abandoned'`. Callers (v2_1b-01 `snapshot_workspace`) set this based on workspace state.

### Canon principles to apply

- **agent-design-before-code** — DDL is exact per §8.1; no inferred columns
- **agent-surface-assumptions** — `approved_runbook_id` is explicitly NULL-allowed in v2.1b because the `lifecycle_synthesized_runbooks` table that would populate it is deferred to v2.2

### Risk mitigations

- Orchestration journal field quality (review MEDIUM-3): columns for `total_steps_executed`, `total_steps_skipped`, `total_hitl_events`, `total_deviations` are captured at snapshot time from the workspace state — populating them disciplines the journal data

### Tests to write

- `mcp-server/src/platform/storage/drift/__tests__/migration-NN-lifecycle.test.ts`:
  - `up()` creates the table with all columns + indexes
  - `down()` drops the table and indexes
  - Idempotency: running `up()` twice fails the second time (expected — migrations are versioned, not idempotent); migration runner prevents double-application
  - Column types match DDL
  - `outcome` column accepts `'complete'` / `'aborted'` / `'abandoned'`; rejects other values if a CHECK constraint is added (optional — add if drift-db convention has CHECK constraints elsewhere)
- `mcp-server/src/platform/storage/drift/__tests__/drift-schema.test.ts` (extend existing):
  - Assert `LifecycleWorkspaceSnapshotRow` type exists with the expected fields

### Verify

1. Migration file exists at `mcp-server/src/platform/storage/drift/migrations/NN-lifecycle-workspace-snapshots.ts`
2. `drift-schema.ts` exports `LifecycleWorkspaceSnapshotRow` type
3. `npm run build` passes
4. `npm test -- drift` passes (including the new migration test)
5. Running the migration against a fresh drift-db creates the table; running `down()` drops it cleanly
6. Schema version bumped

### Done when

- Migration + `down()` both work
- Type definition exported
- Tests pass
- Reviewer confirms: this is the ONLY new lifecycle table in v2.1b; additional tables are a v2.2 scope item
