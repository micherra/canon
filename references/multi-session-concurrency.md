---
name: multi-session-concurrency
description: >-
  Multi-session concurrency protocols for Canon's shared HTTP daemon. Covers
  workspace mutex mechanics, foreign-lock HITL presentation template, and the
  Pre-Mutate Re-Read Gate (S7) for preventing stale-write hazards.
---

# Multi-Session Concurrency <!-- last-updated: 2026-06-24 -->

<!-- Managed by Canon. Manual edits are preserved. -->

**Purpose**: Full mutex and stale-read-hazard protocols. Read BEFORE handling a lock-gated `init_workspace` return or before mutating a shared workspace artifact. See `CLAUDE.md` § Multi-Session Concurrency for the session_id/job_id passing rule and the inline one-liner.

#### Workspace mutex (`.lock`)

`init_workspace` acquires an exclusive file mutex at `{workspace}/.lock` using POSIX-atomic exclusive-create (`O_EXCL`). The lock is released by `finalize_workspace`. Pass `session_id` and `job_id` to both tools so the shared daemon can identify which session holds the lock.

**Session-unique identity**: The orchestrator MUST pass its own `session_id` (the value of `CLAUDE_CODE_SESSION_ID` in its environment) and `job_id` (first 8 chars of `basename($CLAUDE_JOB_DIR)`) to every `init_workspace` and `finalize_workspace` call. The shared daemon cannot read these values from `process.env` — they must be passed explicitly.

**Foreign-lock HITL pattern**: When `init_workspace` returns `lock_gated: true`, the workspace is held by another session. Do NOT proceed. Surface to the user:

```
WORKSPACE LOCKED
Workspace: {workspace}
Owner session: {lock_owner.session_id}
Owner job:     {lock_owner.job_id}
Locked since:  {lock_owner.started_at}

Options:
  1. Wait for the other session to finalize and retry.
  2. If the owner session is dead, retry — the TTL reclaim (2h) will fire automatically.
  3. If you are certain the session is abandoned, contact the owner or wait for TTL.
Do NOT manually delete .lock — race-free reclaim is automatic via TTL.
```

Locks are reclaimed automatically after a 2-hour TTL or when the owner process is confirmed dead (PID liveness check). Never manually delete `.lock` — the exclusive-create reclaim protocol is the only race-safe path.

#### Pre-Mutate Re-Read Gate <!-- S7 -->

Before any agent mutates a shared workspace artifact (journal, board, checkpoint), it must re-read the artifact immediately before the write — not rely on a stale in-context copy from an earlier read earlier in its turn. This prevents the "read-then-long-compute-then-stale-write" hazard where another session advanced the artifact while the agent was computing.

**Protocol:**
1. Before each `log_step` / `batch_log_steps` / `write_orchestrator_checkpoint` call, read the current `journal.json` state if needed for merge decisions.
2. Use `write_orchestrator_checkpoint` immediately (not deferred) — a stale checkpoint blocks correct resume.
3. When a `BOARD_LOCKED` error (version conflict) is returned by an MCP tool, treat it as a retryable conflict: re-read the current board state and re-apply your update against the new version.
4. Never cache journal or board snapshots across multiple tool calls — each MCP call sees the current on-disk state.

**Shell helper**: The `hooks/pre-mutate-reread.sh` script (S8) validates that an in-context snapshot age does not exceed a freshness threshold. Agents may invoke it before multi-step journal writes to detect stale-read hazards at the hook layer.
