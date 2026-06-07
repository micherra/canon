---
id: lazy-freshness-gate
title: Lazy Freshness Gate for Commit-Granularity Caches
severity: convention
scope:
  file_patterns:
    - "mcp-server/src/features/knowledge-graph/**"
    - "mcp-server/src/features/**/ensure-*.ts"
tags:
  - caching
  - freshness
  - mcp-server
---

When adding a new derived-data cache that must remain fresh at commit granularity, mirror the `ensure*Fresh` pattern: store a commit-SHA marker in the cache's own key-value table, compare it to `getCurrentHead` on each read at the tool-handler or function boundary, and run the incremental compute pipeline on mismatch. Never gate on per-read mtime or dirty-tree scans — commit granularity is the correct precision for tool-call freshness.

## Rationale

Three independent caching subsystems applied this pattern before it was documented, confirming the invariants are stable and non-obvious. The pattern solves two competing forces: (1) callers need a consistent view of derived state that reflects the latest commit; (2) re-computing expensive derived state on every read would cause thrash and serve a view that diverges from what CI or collaborators see.

The gate is cheap on the hot path: a single SQL lookup (`SELECT value FROM meta WHERE key = ?`) or a column read (`computed_at_commit`) determines freshness. The pipeline runs only when the stored SHA differs from HEAD. After a full-success run, the marker is stamped — crashed or partial runs leave the marker absent, so the next read triggers a rebuild rather than serving stale data.

### The seven shared invariants

All three instances share these invariants without exception:

1. **Own-store marker**: The cache key is a HEAD SHA stored in the cache's own existing key-value table — never in a global or shared marker store.
2. **Commit-granularity staleness check**: Freshness is determined by comparing stored SHA to `getCurrentHead`; no mtime comparisons, no dirty-tree scans.
3. **Incremental compute on mismatch**: The pipeline is incremental when available (content-hash skips unchanged files); the staleness gate is the trigger.
4. **`async void`, never throws**: The gate function returns `void` and is always fail-open — errors are caught and logged as warnings, degrading to the last-good state.
5. **No-op when store is absent**: Guard the store-exists check before reading; a missing or uninitialized store is treated as stale, and the pipeline re-initializes.
6. **No-op when HEAD is null**: A null HEAD indicates a non-git checkout. Do not rebuild on every read in that case — treat as already fresh (or handle per-subsystem semantics; see Exceptions).
7. **Marker stamped only after full-success pipeline run**: A crashed or incomplete run does NOT stamp the marker. The next read re-triggers the pipeline.

### Evidence

Three instances from distinct caching subsystems in `mcp-server`:

| Instance | Function | Cache | Marker | Build |
|----------|----------|-------|--------|-------|
| 1 | `ensureGitIntelFresh` | Git-intel tables (`computed_at_commit` on `hotspot_scores`) | `hotspot_scores.computed_at_commit` | Pre-existing |
| 2 | `ensureGraphFresh` | Structural KG (`graph_head_commit` in `meta`) | `meta` KV table (`GRAPH_HEAD_COMMIT_KEY`) | PR #303 (kg-sync hardening) |
| 3 | `ensureGraphFresh` single-flight extension | Same structural KG — added concurrent-caller deduplication via in-process `inFlight` map | Same | Post-PR #303 hardening |

Instance 2 explicitly named instance 1 as its proof-of-concept in the DESIGN.md, confirming the pattern was consciously transferred across distinct subsystems.

## Pattern Shape

```typescript
// Canonical form — all seven invariants visible
async function ensure*Fresh(projectDir: string, opts?: Opts): Promise<void> {
  try {
    // Invariant 5: no-op when store absent
    if (!storeExists(projectDir)) return;

    // Invariant 6: no-op when HEAD null (non-git checkout)
    const head = getCurrentHead(projectDir);
    if (head === null) return;

    // Invariant 1 + 2: compare own-store marker to HEAD SHA
    const stored = readStoredMarker(projectDir); // cheap read, no full DB init
    if (stored === head) return; // already fresh

    // Invariant 3: run incremental pipeline on mismatch
    // Invariant 7: marker stamped ONLY inside pipeline on full success
    await run*Pipeline(projectDir, { ...opts });
  } catch (err) {
    // Invariant 4: fail-open — log warning, never throw
    console.warn(`[ensure*Fresh] failed: ${err}`);
  }
}
```

### Reference implementations

| Property | `ensureGitIntelFresh` | `ensureGraphFresh` |
|---|---|---|
| File | `mcp-server/src/features/knowledge-graph/git-intel/git-intel-pipeline.ts` | `mcp-server/src/features/knowledge-graph/ensure-graph-fresh.ts` |
| Cache | Git-intel tables | Structural KG |
| Marker | `hotspot_scores.computed_at_commit` (column) | `meta.graph_head_commit` (KV row) |
| Compute | `runGitIntelPipeline` | `runPipeline` (incremental default) |
| Async | No (sync DB handle held by caller) | Yes (async void, own handle, single-flight) |
| Single-flight | No (synchronous, not needed) | Yes (`inFlight` map per DB path) |
| Gate wiring | Called inside `getFileContext` | Called at handler boundary + inside `getFileContext` |

Note: `ensureGitIntelFresh` is synchronous because the caller already holds an open DB handle. The async/sync distinction is a consequence of the calling convention, not a violation of invariant 4 — both are fail-open and never throw.

## Examples

**Good — mirrors the pattern:**

```typescript
// mcp-server/src/features/knowledge-graph/ensure-graph-fresh.ts
export async function ensureGraphFresh(
  projectDir: string,
  opts?: EnsureGraphFreshOptions,
): Promise<void> {
  try {
    const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    if (!existsSync(dbPath)) return;               // Invariant 5: absent store → no-op

    const head = getCurrentHead(projectDir);
    if (head === null) return;                     // Invariant 6: non-git checkout → no-op

    const marker = readStoredMarker(dbPath);
    const stale = marker === undefined || marker !== head;
    if (!stale) return;                            // Invariant 2: commit-SHA compare

    await refreshOnce(projectDir, dbPath, opts?.sourceDirs); // Invariant 3 + 7
  } catch (err) {
    console.warn(`[ensure-graph-fresh] freshness refresh failed: ${err}`); // Invariant 4
  }
}
```

**Bad — eagerly rebuilds on every read without a staleness gate:**

```typescript
// WRONG: re-runs pipeline on every getFileContext call regardless of HEAD
async function getFileContextHandler(projectDir: string, filePath: string) {
  await runPipeline(projectDir); // no staleness check, no marker
  return queryGraph(projectDir, filePath);
}
```

This causes rebuild thrash on every request and does not serve a view consistent with CI.

**Bad — uses mtime instead of commit SHA:**

```typescript
// WRONG: mtime freshness is not commit-granularity and is not portable across
// filesystems, clones, or CI environments
const dbMtime = statSync(dbPath).mtimeMs;
const srcMtime = statSync(join(projectDir, 'src')).mtimeMs;
if (dbMtime < srcMtime) await runPipeline(projectDir);
```

Working-tree edits (uncommitted) would trigger a rebuild on every keystroke, producing a graph that diverges from collaborators and CI. Commit granularity is the correct precision.

**Bad — stamps the marker before the pipeline completes:**

```typescript
// WRONG: marker written before success — a crashed pipeline leaves stale marker
await setMeta(db, 'graph_head_commit', head);
await runPipeline(projectDir); // if this throws, marker is already stamped
```

A failure leaves the marker pointing to HEAD even though the store is stale. The next read incorrectly treats it as fresh. Invariant 7 requires stamping only inside the pipeline after full success.

## Exceptions

- **Non-git-keyed caches**: Caches keyed on inputs other than a git commit (e.g., keyed on a remote API response, a timestamp, or a content hash of external data) should use the appropriate staleness signal for that data source. Do not use `getCurrentHead` as a proxy for non-git staleness.
- **Truly per-request data**: Data that must be current to the working tree (not the last commit) should not use commit-SHA gating. Examples: linter outputs on the current file contents, or pre-commit checks. These legitimately require per-read computation.
- **Synchronous callers with open DB handle**: When the caller already holds an open, initialized DB handle (as with `ensureGitIntelFresh`), the function may be synchronous. The fail-open invariant (invariant 4) still applies — callers must catch or the pipeline must not throw.
- **Scoped pipeline runs**: When the pipeline is scoped (e.g., `sourceDirs` restricts the scan to a subdirectory), the freshness marker may not be stamped after the scoped run, because orphan pruning and a full-project marker update are skipped. This is intentional — only full-project runs stamp the global marker. Scoped runs produce an accurate partial result but leave the gate armed for a full refresh on the next full-project read.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "I'll just rebuild on every request — it's simpler." | Rebuild thrash degrades tool-call latency for every request after the first. The incremental pipeline exists precisely to avoid this cost. | Add the staleness gate. The hot path is a single SQL lookup. |
| "Mtime is close enough for freshness." | Mtime is not portable across git clones, CI environments, or filesystems. It breaks for uncommitted working-tree edits, which would trigger a rebuild on every keystroke and diverge from collaborators. | Use `getCurrentHead` and compare the stored commit SHA. |
| "I'll use a global marker instead of an own-store marker." | A global marker creates coupling between unrelated caching subsystems. A scoped refresh of one subsystem would incorrectly mark others as fresh. | Store the marker in the cache's own table (invariant 1). |
| "I'll stamp the marker before the pipeline to avoid repeated rebuilds on concurrent callers." | Stamping before success means a crashed pipeline leaves a stale store marked as fresh. Use the `inFlight` single-flight map for concurrent-caller deduplication instead. | Stamp the marker only inside the pipeline after a fully successful run (invariant 7). |
| "I don't need to guard for a null HEAD — the pipeline will handle it." | A null HEAD means git is unavailable. The pipeline would rebuild on every read in a non-git checkout. The guard prevents this thrash. | Check `getCurrentHead` before comparing the marker (invariant 6). |

## Verification

- [ ] Every `ensure*Fresh` function in `mcp-server/src/` stores its freshness marker in the cache's own table, not in a global or shared store.
- [ ] The staleness check compares stored SHA to `getCurrentHead` — no mtime, no stat calls.
- [ ] The function signature returns `void` (or a type-level equivalent) and has a top-level `catch` that logs a warning and does not re-throw.
- [ ] The marker is written inside the pipeline function, after a fully successful run — not before the pipeline call.
- [ ] The no-op guards (store absent; HEAD null) appear before the staleness comparison.
- [ ] Both reference implementations exist at the declared paths:
  - `mcp-server/src/features/knowledge-graph/git-intel/git-intel-pipeline.ts` — `ensureGitIntelFresh`
  - `mcp-server/src/features/knowledge-graph/ensure-graph-fresh.ts` — `ensureGraphFresh`
