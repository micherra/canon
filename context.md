## Workspace Context: Fix resume-after-rate-limit worktree context loss

### Goal
Persist worktree tracking in board state so the orchestrator can resume implementors in their existing worktrees after rate-limit interruptions.

### Architecture Summary
- Worktree metadata stored inside `WaveResult` per wave (not a separate board field)
- `SpawnPromptEntry` extended with `isolation` and `worktree_path` fields
- `EnterAndPrepareStateResult` extended with `worktree_entries` for resume
- No SQLite DDL changes — JSON within existing `wave_results` TEXT column

### Key Patterns
- All new Zod schema fields use `.optional()` for backward compat
- Worktree entries use `{task_id, worktree_path, branch, status}` shape
- Status values: "active" (spawned, not yet merged), "merged", "failed"

### Known Issues
- None yet

### Agent Notes
- None yet
