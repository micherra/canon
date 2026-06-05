# shared/lib/ — Agent Reference

## Purpose

Pure utility modules used by feature tools. No MCP dependencies — these are plain TypeScript functions that features import directly. `lib/` is a leaf: these modules may not import from `features/`, `domains/`, or `platform/`.

## Modules

### `commit-trailers.ts` — Canon Git Trailers

Formats git trailer blocks for Canon-managed commits.

**Exports:**
- `TrailerOpts` — `{ workflow: string; agent: string; state: string; taskId?: string }`
- `formatCommitTrailers(opts: TrailerOpts): string` — returns a ready-to-embed trailer block; returns empty string when any required field is missing
- `buildCommitMessage(subject, body, trailerOpts): string` — assembles a full commit message with subject, optional body, trailer block, and `Co-Authored-By` line

**Trailer format:**
```
Canon-Workflow: {slug}
Canon-Agent: {agent-type}
Canon-State: {state-id}
Canon-Task: {task-id}          # wave tasks only (omitted when taskId not provided)
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

**Usage pattern:** Agents receive the pre-formatted trailer block in their spawn prompt. Append it after the commit body, before `Co-Authored-By`.

---

### `file-claims.ts` — Concurrent Workflow File Claims

Manages `.canon/claims.json` — tracks which files are targeted by active workflows. Enables early conflict warnings when concurrent workflows plan changes to the same files.

**Exports:**
- `readClaims(projectDir): ClaimsFile` — reads and returns current claims, pruning entries older than 24h; returns empty structure on any error (never throws)
- `writeClaims(projectDir, claims): void` — atomic write (temp + rename); creates `.canon/` if missing
- `registerClaims(projectDir, workflow, filePaths): void` — idempotent; re-registering the same workflow+file is a no-op
- `releaseClaims(projectDir, workflow): void` — removes all entries for a workflow; no-op for unknown workflows
- `checkClaimOverlaps(projectDir, workflow, filePaths): ClaimOverlap[]` — returns overlapping files from OTHER workflows; same-workflow claims are ignored

**Types:**
- `ClaimsFile` — `{ version: 1; claims: Record<string, ClaimEntry[]> }`
- `ClaimEntry` — `{ workflow: string; claimed_at: string }` (ISO-8601 timestamp)
- `ClaimOverlap` — `{ file_path: string; workflows: string[] }`

**Key patterns:**
- All functions are synchronous (claims file is small, kept in `.canon/`)
- Never throws — all error conditions return empty structures or no-ops
- 24h TTL: stale claims are pruned automatically on every `readClaims` call
- Atomic writes prevent partial reads under concurrent access

**Integration points (do not call directly — orchestration tools handle this):**
- `write_plan_index` (architect's affected-file list) and `init_workspace` flow → calls `registerClaims`
- `finalize_workspace` → calls `releaseClaims`
- `init_workspace` preflight → calls `checkClaimOverlaps` and surfaces warnings

---

### `janitor-lock.ts` — Janitor Concurrency Lock

Manages `.canon/janitor.lock` — a PID + mtime lock that prevents concurrent janitor runs and tracks last-run timestamp. Independent from `learn-lock.ts`.

**Exports:**
- `JanitorLockResult` — `{ acquired: true; previousMtime: number | null } | { acquired: false; reason: "already_locked" | "stale_reclaim_failed" }`
- `acquireJanitorLock(canonDir, staleAfterMs): Promise<JanitorLockResult>` — exclusive create (O_EXCL); reclaims stale locks by mtime threshold or dead PID detection
- `commitJanitorLock(canonDir): Promise<void>` — updates lock mtime to now after a successful run
- `releaseJanitorLock(canonDir): Promise<void>` — removes lock file; ignores ENOENT
- `getLastJanitorTimestamp(canonDir): Promise<number | null>` — reads lock mtime; null when no lock exists

**Key patterns:**
- Lock body = current PID string; mtime = last successful janitor run timestamp
- Stale reclaim: unlink then O_EXCL re-create; loser gets EEXIST → `stale_reclaim_failed` (fail-safe)
- Dead PID detection via `process.kill(pid, 0)` probe before mtime staleness check
- TOCTOU window acknowledged — acceptable for single-process CLI tool (documented in source)

---

### `subsystem-key.ts` — Area Memory Subsystem Key Derivation

**Exports:**
- `deriveSubsystemKey(filePath: string): string` — strips `mcp-server/src/`, `tools/`, `services/`, and `__tests__/` path segments to produce stable subsystem keys like `features/orchestration` or `platform/storage/drift`; used by `AreaMemoryDao` and all write paths that store area observations.

Added 2026-05-29.

---

## When to Extract to shared/lib/

A pure function belongs in `shared/lib/` when:
1. It is needed by two or more features in different bounded contexts (e.g., `features/orchestration` AND `features/diagnostics`), AND
2. No single bounded context can own it without creating a prohibited cross-feature import

**Decision test**: If placing the function in context A requires context B to import from A (violating the no-cross-feature rule), extract to `shared/lib/` with a docblock explaining why.

**Shape requirement**: `shared/lib/` modules must be pure (no I/O, no DB calls, no side effects). If the function requires I/O, use a structural interface (like `AreaMemoryWriter`) instead of extracting the I/O code to shared.

Reference implementations:
- `subsystem-key.ts` — `deriveSubsystemKey` needed by orchestration AND diagnostics/platform layers
- `commit-trailers.ts` — commit formatting needed by all code-writing agents

## Not Standalone MCP Tools

These modules are consumed by `features/orchestration/` tools. Agents do not call them via MCP — they are wired into `init_workspace`, `finalize_workspace`, and the janitor service automatically.
