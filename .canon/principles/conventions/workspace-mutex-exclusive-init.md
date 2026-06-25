---
id: workspace-mutex-exclusive-init
title: Workspace Mutex — init_workspace Acquires an Exclusive Lock Before Proceeding
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "mcp-server/src/features/orchestration/**"
    - "agents/**"
    - "CLAUDE.md"
    - "references/**"
tags:
  - concurrency
  - orchestration
  - workspace
  - mutex
---

`init_workspace` MUST acquire an exclusive workspace lock (`{workspace}/.lock`) using a race-free filesystem primitive (POSIX O_EXCL / `open(..., "wx")`) before proceeding. If a foreign live lock is present (not stale by TTL or dead-PID), `init_workspace` MUST return a gated signal (`lock_gated: true`, `lock_owner`) and the orchestrator MUST surface this as a HITL gate before proceeding. Stale locks (TTL > 2h, or owner PID confirmed dead via `process.kill(pid, 0)` returning ESRCH) MUST be reclaimed automatically and logged as a `log_decision` event. `finalize_workspace` MUST release only the lock owned by the calling session (session_id guard); releasing a foreign lock is a no-op. Corrupt unreadable locks with a fresh mtime MUST be treated as gated (fail-safe posture — D7).

**Implementation reference:** `mcp-server/src/features/orchestration/services/workspace-lock.ts`. Wired at `init_workspace` create path and resume path, and released at `finalize_workspace`. See ADR-0021.

**Orchestrator identity:** The lock record carries `{ session_id, job_id, started_at, pid }`. `session_id` and `job_id` are orchestrator-supplied (from `CLAUDE_CODE_SESSION_ID` and `basename($CLAUDE_JOB_DIR)`) because the MCP server runs as a shared daemon and cannot derive the calling session's identity from `process.env`.

## Rationale

**The 2026-06-24 incident:** Sessions `72f2b372` and `6429ca3b` both called `init_workspace` (resume path) on the same workspace simultaneously with no guard. Neither session was aware of the other until observing collision symptoms: `REVIEW.md` overwrite (OOOOOOOOOO1), `SendMessage` misrouting (OOOOOOOOOO2), ADR number collision (watch_ZZZZZZZ1 instance 13), and git state mutated underfoot (OOOOOOOOOO3). The `.lock` reference in CLAUDE.md "What You May Do Directly" was false confidence — no tool created or checked any lock file.

Without a mutex, any pair of orchestrators driving the same workspace race at every state-mutating call: `log_step`, `write_orchestrator_checkpoint`, git commits, and artifact writes all touch shared state with no isolation. The downstream failures are non-deterministic and difficult to diagnose (they look like reviewer mistakes or file corruption, not concurrency bugs).

**Why O_EXCL and not temp+rename:** `atomic-write.ts`'s temp+rename pattern is correct for file *writes* but clobbers any existing file. O_EXCL fails `EEXIST` atomically if a lock already exists — the only race-free create-if-not-exists primitive on a shared POSIX filesystem. Using rename for locking would overwrite a live lock and silently grant two sessions concurrent access.

**Why HITL and not hard block:** Some legitimate multi-session workflows exist — a background learner running alongside a foreground build, or a ship-watch alongside a new build. The mutex surface is HITL (present `lock_owner` to the user for confirmation) rather than an unconditional block. The user can decide whether the foreign session is actually competing or merely stale.

## The Lock Lifecycle

```
init_workspace (create)  →  tryAcquireWorkspaceLock
  ├── no lock → write {workspace}/.lock with O_EXCL → proceed
  ├── live foreign lock → return lock_gated: true, lock_owner → orchestrator presents HITL
  └── stale lock (TTL >2h or dead PID) → reclaim, log_decision, write new lock → proceed

finalize_workspace → releaseWorkspaceLock
  ├── own lock (session_id matches) → delete {workspace}/.lock
  └── foreign lock (session_id mismatch) → no-op (never release another session's lock)
```

**Lock record schema:**
```json
{ "session_id": "...", "job_id": "72f2b37", "started_at": "2026-06-24T19:45:00Z", "pid": 12345 }
```

## Examples

**Bad — two orchestrators drive the same workspace with no guard:**

```
Session A: init_workspace({ workspace: "canon--foo/bar" })  → { created: true }
Session B: init_workspace({ workspace: "canon--foo/bar" })  → { created: true }
# Both proceed. Both write log_step, both commit, both write REVIEW.md.
# REVIEW.md ends up with B's verdict; A's verdict is lost.
```

**Good — O_EXCL locks the workspace; second caller is gated:**

```
Session A: init_workspace(...)  → acquires .lock { session_id: "A", job_id: "72f2b37" }
Session B: init_workspace(...)  → .lock exists, TTL fresh, PID alive
                                → returns { lock_gated: true, lock_owner: { session_id: "A", job_id: "72f2b37", started_at: ... } }
Orchestrator B: presents HITL:
  "Workspace is held by session A (job 72f2b37, started 19:45).
   Wait for it to finalize, or reclaim if you know it has crashed?"
```

**Good — stale lock reclaimed automatically:**

```
Session A: crashed mid-build (PID 12345 no longer exists)
Session B: init_workspace(...) → reads .lock, checks process.kill(12345, 0) → ESRCH
                               → log_decision("reclaimed stale lock: dead PID 12345 / session A")
                               → deletes .lock, writes new .lock for B → proceed
```

**Good — finalize releases only own lock:**

```
Session A: finalize_workspace(...) → reads .lock, session_id matches A → deletes .lock
Session B (accidentally): finalize_workspace(same workspace)
                         → reads .lock, session_id is "A" ≠ "B" → no-op (B does not own this lock)
```

## Exceptions

- Background read-only observers (e.g., ship-watch ticks that only read journal.json, not call `init_workspace`) do not require the mutex — the lock is only acquired when `init_workspace` is called.
- Learner writes exclusively to `.canon/` (gitignored), which is outside the build workspace — no mutex needed.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "CLAUDE.md mentions `.lock` — isn't that enough?" | The old `.lock` reference was a documentation placeholder with no implementation behind it. Docs don't enforce concurrency safety; code does. | Verify `init_workspace` actually calls `tryAcquireWorkspaceLock`. It does since PR #416. |
| "Both sessions are running on the same machine — they won't conflict." | Same-machine doesn't help: both sessions share the same filesystem and the same MCP daemon. Race conditions are reproducible locally. | Use the mutex regardless of topology. |
| "The learner runs in `.canon/` so it doesn't need this." | Correct — learner is explicitly exempt (writes only to gitignored `.canon/`). This rule applies to build orchestrators that call `init_workspace`. | Learner: exempt. Build orchestrators: must use `init_workspace`. |

## Verification

```bash
# Confirm workspace-lock module is wired to init_workspace:
grep -n "tryAcquireWorkspaceLock\|releaseWorkspaceLock" \
  mcp-server/src/features/orchestration/services/workspace-lock.ts \
  mcp-server/src/features/orchestration/tools/init-workspace.ts \
  mcp-server/src/features/orchestration/tools/orchestration-journal.ts

# Confirm O_EXCL is used (not rename):
grep -n '"wx"' mcp-server/src/features/orchestration/services/workspace-lock.ts
```

Expected: `tryAcquireWorkspaceLock` appears in init-workspace.ts; `releaseWorkspaceLock` appears in orchestration-journal.ts; `"wx"` appears in workspace-lock.ts.

## Related

- [[step-scoped-review-artifacts]] (OOOOOOOOOO1) — artifact-level race within a workspace; the mutex reduces the window but step-scoped paths are still required for fan-out builds
- [[session-unique-agent-naming]] (OOOOOOOOOO2) — SendMessage misrouting under concurrent sessions; complementary behavioral guard
- [[pre-mutate-reread-gate]] (OOOOOOOOOO3) — per-operation re-read gate for shared git/journal state; the mutex is the coarse outer guard; re-read is the fine inner guard
- `per-connection-scope-threading` — sibling MCP-level concurrency convention; the mutex is workspace-level isolation; scope threading is per-request isolation within one process
