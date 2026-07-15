# shared/lib/ — Agent Reference

## Purpose

Pure utility modules used by feature tools. No MCP dependencies — these are plain TypeScript functions that features import directly. `lib/` is a leaf: these modules may not import from `features/`, `domains/`, or `platform/`.

## Modules

### `commit-trailers.ts` — Canon Git Trailers

Formats git trailer blocks for Canon-managed commits.

**Exports:**
- `TrailerOpts` — `{ workflow: string; agent: string; state: string; taskId?: string; evolutionId?: string }`
- `formatCommitTrailers(opts: TrailerOpts): string` — returns a ready-to-embed trailer block; returns empty string when any required field is missing
- `buildCommitMessage(subject, body, trailerOpts): string` — assembles a full commit message with subject, optional body, trailer block, and `Co-Authored-By` line

**Trailer format:**
```
Canon-Workflow: {slug}
Canon-Agent: {agent-type}
Canon-State: {state-id}
Canon-Task: {task-id}          # wave tasks only (omitted when taskId not provided)
Canon-Evolution: {id}          # apply-provenance only (omitted when evolutionId absent); after Canon-Task, or after Canon-State when no task (ADR-0034)
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

### `atomic-write.ts` — Atomic File Write Utilities

**Exports:**
- `atomicWriteFile(filePath, data): Promise<void>` — writes to a temp file in the same directory then renames; rename() within the same filesystem is POSIX-atomic; prevents partial reads
- `atomicWritePair(filePath1, data1, filePath2, data2): Promise<void>` — writes both temp files first, then renames both; callers see either both old files or both new files, never a mix; use when two files must stay in sync (e.g. `REVIEW.md` + `REVIEW.meta.json`)

**Key pattern:** `atomicWritePair` closes the md-new/meta-old divergence window that would arise from two sequential `atomicWriteFile` calls crashing between the first and second rename. Used by `write_review` for all REVIEW pairs.

Added `atomicWritePair` 2026-06-24.

---

### `subsystem-key.ts` — Area Memory Subsystem Key Derivation

**Exports:**
- `deriveSubsystemKey(filePath: string): string` — strips `mcp-server/src/`, `tools/`, `services/`, and `__tests__/` path segments to produce stable subsystem keys like `features/orchestration` or `platform/storage/drift`; used by `AreaMemoryDao` and all write paths that store area observations.

Added 2026-05-29.

---

---

### `overlay-untrusted-text.ts` — Opaque-Box UntrustedText Type (ADR-0026)

Implements the boundary type that makes raw-emission of overlay free-text a `tsc` TS2322 error.

**Exports:**
- `UntrustedText` — opaque object type (`{ readonly [tag]: "UntrustedText"; readonly _v: string }`), NOT a `string` subtype. Assigning to a `string` field produces TS2322 at compile time.
- `brandUntrusted(v: string): UntrustedText` — stamps at load boundary; call in `parser.ts` / `routine.ts` only
- `renderUntrusted(v: UntrustedText, opts: { source: string }): string` — model-facing unwrap: fences for `source==="project"`, passes through for `plugin`/`undefined`
- `renderUntrustedProjection(v: UntrustedText, opts): string` — projection variant (same fence behavior)
- `rawUntrustedForStructuralUse(v: UntrustedText): string` — audited escape hatch for non-model-facing use (grep-trackable, CI-tested invariant that callers are structural-only)
- `mapUntrusted(v: UntrustedText, fn: (s: string) => string): UntrustedText` — brand-preserving transform; use for structural operations that must not lose the brand

**Key constraint:** `_v` never escapes this module directly. All external callers go through the four named entry points above.

Added 2026-06-27.

---

### `overlay-closed-domain.ts` — Shared Closed-Domain Validators (ADR-0026 §Amendment-2)

Shared charset constants and filter functions for Principle/Routine closed-domain fields. Both writers (`parser.ts` and `matcher.ts`) import from here — prevents second-writer bypass.

**Exports:**
- `LAYER_CHARSET` — regexp for valid layer name characters
- `FILE_PATTERN_CHARSET` — regexp for valid file-pattern characters (admits glob syntax chars `(){}!,`)
- `TAG_CHARSET` — regexp for valid tag characters
- `FILE_PATTERN_MAX_LEN: number` — max allowed length for a single `file_patterns` entry (bounds DP table in `matchGlob`)
- `filterLayers(arr: string[]): string[]` — drop entries not matching `LAYER_CHARSET` (fail-closed, with `console.warn`)
- `filterFilePatterns(arr: string[]): string[]` — drop entries not matching `FILE_PATTERN_CHARSET` OR exceeding `FILE_PATTERN_MAX_LEN`
- `filterTagArray(arr: string[]): string[]` — drop entries not matching `TAG_CHARSET`

Added 2026-06-27.

---

### `glob-matcher.ts` — Linear-Time Glob Matcher (ADR-0026 §Amendment-3)

Replaces `globToRegex`+`new RegExp` in `matcher.ts` with a pure DP function that has no `new RegExp` on the pattern at match time.

**Exports:**
- `matchGlob(pattern: string, path: string): boolean` — O(m·n) wildcard DP match; supports `*` (non-slash wildcard) and `**` (full wildcard); segment-boundary anchor (`^` or `/`) matches Canon's `(^|/)` semantic

**Why this module exists:** `globToRegex` + `new RegExp` admitted two exploit classes via the `FILE_PATTERN_CHARSET`-legal chars `({` etc.:
1. **Throw-DoS**: patterns like `"("` → `new RegExp("(^|/)($")` → uncaught `SyntaxError` that propagated out of `loadAllPrinciples`
2. **ReDoS**: patterns like `"(*){2,}"` → `([^/]*){2,}` (nested unbounded quantifier) → catastrophic backtracking (measured 13s at n=28)

The DP approach removes the regex engine from the match path entirely.

Added 2026-06-27.

---

### `waves-compiler.ts` — canon-waves DAG Compiler (SYNTHESIS Inc-5, Increment 1, ADR-0054)

Pure leaf module: compiles a validated `TaskDag` + per-task prompt seeds into a `WavesEnvelope` for the `workflows/canon-waves.js` runner. No per-flow branches — behavior comes only from DAG/plan fields.

**Exports:**
- `compileWaves(input: CompileWavesInput): CompileWavesResult` — `CompileWavesResult` is `{ ok: true; envelope: WavesEnvelope } | { ok: false; errors: string[] }`. Fail-closed at every stage — DAG-validation failure, any task with a non-empty `depends_on` (multi-wave is out of scope for Increment 1), or a missing/blank `prompt_seed` each return `{ ok: false, errors }`, never a partial or guessed envelope.
- `sanitizeTaskId(taskId: string): string` — non-charset chars → `-`; sole sanitizer for embedding a task_id in a branch name or worktree path
- `deriveTaskBranch(taskId: string): string` — `canon-task/{sanitized}`; sole owner of the branch-name convention, called by both `compileWaves` and `compile-waves.ts` so the envelope's `branch` and the worker prompt's embedded `BRANCH=` line can't drift apart
- `deriveTaskWorktreePath(projectDir: string, taskId: string): string` — `{projectDir}/.canon/worktrees/{sanitized}`

**Key pattern:** `merge_order` is derived from the same `branch` field `compileWaves` assigns each task (not a raw `task_id`) — `workflows/canon-waves.js` feeds `merge_order` straight into `git merge --no-ff`, so a raw task_id there would merge against branches that were never created. Sorted (not insertion-order) for determinism.

Consumed by `features/orchestration/tools/compile-waves.ts` (the `compile_waves` MCP tool) — a thin wrapper that reads `task-dag.yaml` + task plans off disk and hands them to `compileWaves`.

Added 2026-07-14.

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
