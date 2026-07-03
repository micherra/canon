/**
 * drift-db-leak-guard — global vitest tripwire against test-fixture pollution
 * of the two REAL protected `.canon/drift.db` files (repo-root + mcp-server).
 *
 * Root cause this guards against: an integration test that drives the real
 * `finalizeWorkspace` / `appendFlowRun` path with a live-cwd `projectDir`
 * (instead of an isolated `mkdtemp` project dir) writes real `flow_runs` rows
 * into whichever `.canon/drift.db` sits at that cwd. See PROBE-FINDINGS.md /
 * `docs/adr` context for the historical incident this guard prevents from
 * recurring.
 *
 * Design:
 * - `checkNoDriftDbGrowth` is a PURE comparison (no I/O) so it can be trip-
 *   tested deterministically without touching any real database.
 * - `installDriftDbLeakGuard` is the impure vitest-integration half: it
 *   resolves the two protected DB paths by walking up from THIS MODULE's own
 *   file location to the git-root marker (`.git`) — never from
 *   `process.cwd()`, which is exactly the value the leak itself was keyed on.
 * - Snapshots are taken per-file via `beforeAll`/`afterAll` (registered once,
 *   globally, via `vitest-setup-drift-guard.ts` in `setupFiles`) rather than
 *   per-test. Vitest runs test FILES as separate workers/processes, so a
 *   global `beforeAll`/`afterAll` pair fires once per worker — this means a
 *   leak surfaces attributed to "the suite run as a whole" rather than a
 *   single test, but it still traps the row-count delta at the process
 *   boundary, which is what a global setupFiles hook can offer. Attribution
 *   to the exact offending file remains manual (see PROBE-FINDINGS.md), but
 *   recurrence of ANY new leak (not just `flow_runs`, any growth in this
 *   table) will fail the suite loudly instead of silently polluting real data.
 *
 * A missing DB file is snapshotted as the sentinel value `-1` ("must not be
 * created"). If a later snapshot finds the file created with any row count
 * (including zero), that counts as growth — a fresh `.canon/drift.db`
 * appearing where none existed is itself a signal that something wrote to a
 * live-cwd-relative path during the test run.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";

/** Sentinel value snapshotted when a protected DB file does not exist. */
const ABSENT = -1;

export class DriftDbLeakError extends Error {
  readonly dbPath: string;
  readonly baselineCount: number;
  readonly currentCount: number;

  constructor(dbPath: string, baselineCount: number, currentCount: number) {
    super(
      `drift-db-leak-guard: ${dbPath} flow_runs count grew from ${baselineCount} to ` +
        `${currentCount} during this test run. A test drove a real finalize/analytics ` +
        `write path (finalizeWorkspace -> appendFlowRun -> getDriftDb) against a live-cwd ` +
        `projectDir instead of an isolated mkdtemp project dir. Isolate the offending ` +
        `test's projectDir -- do not suppress this guard.`,
    );
    this.name = "DriftDbLeakError";
    this.dbPath = dbPath;
    this.baselineCount = baselineCount;
    this.currentCount = currentCount;
  }
}

/**
 * PURE comparison — no I/O. Throws `DriftDbLeakError` naming the first
 * protected path whose `flow_runs` count in `current` exceeds `baseline`
 * (including the "newly appeared" case: baseline === ABSENT, current >= 0).
 */
export function checkNoDriftDbGrowth(
  baseline: Map<string, number>,
  current: Map<string, number>,
): void {
  const paths = new Set([...baseline.keys(), ...current.keys()]);
  for (const dbPath of paths) {
    const before = baseline.get(dbPath) ?? ABSENT;
    const after = current.get(dbPath) ?? ABSENT;
    if (after > before) {
      throw new DriftDbLeakError(dbPath, before, after);
    }
  }
}

/**
 * Read-only snapshot of `SELECT COUNT(*) FROM flow_runs` for a single DB
 * path. Returns the sentinel `ABSENT` (-1) when the file does not exist, and
 * `0` when the file exists but the `flow_runs` table has not been created yet
 * (fresh/empty schema — never treated as an error).
 *
 * Uses Node's built-in `node:sqlite` (`DatabaseSync`) rather than
 * `better-sqlite3`. This module is imported by every test file via
 * `setupFiles` (`vitest-setup-drift-guard.ts`), and vitest resolves
 * `setupFiles` module graphs into its module cache before each test file
 * runs. A top-level `import Database from "better-sqlite3"` here would
 * therefore resolve `better-sqlite3` into the cache ahead of any
 * `vi.mock("better-sqlite3", ...)` a test declares, silently defeating that
 * mock (Codex P2 finding, PR #446) — e.g.
 * `features/history/__tests__/archive-service.test.ts` mocks `better-sqlite3`
 * to avoid real orchestration.db I/O, but the guard's early import made that
 * mock a no-op and the test quietly exercised real SQLite I/O instead.
 * `node:sqlite` is a Node builtin — nothing mocks it, so it can never poison
 * another test's mock of a third-party module.
 */
export function snapshotFlowRunsCount(dbPath: string): number {
  if (!existsSync(dbPath)) return ABSENT;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) as count FROM flow_runs").get() as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  } catch {
    // Table doesn't exist yet (schema not migrated) — treat as zero rows, not an error.
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Walk up from `startDir` to the nearest ancestor containing a `.git` marker
 * (directory for a normal checkout, or a `.git` FILE for a linked worktree —
 * `existsSync` matches either). Never falls back to `process.cwd()`.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `drift-db-leak-guard: could not locate repo root (.git marker) walking up from ${startDir}`,
      );
    }
    dir = parent;
  }
}

/** Resolve the two protected real drift.db paths relative to THIS module's own location. */
function resolveProtectedDbPaths(): string[] {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(thisDir);
  return [join(repoRoot, ".canon", "drift.db"), join(repoRoot, "mcp-server", ".canon", "drift.db")];
}

/**
 * Register global `beforeAll`/`afterAll` hooks (per test-file worker) that
 * snapshot both protected DBs' `flow_runs` counts and fail loudly on growth.
 * Call once from a `setupFiles` entry (`vitest-setup-drift-guard.ts`) — do
 * not call from individual test files.
 */
export function installDriftDbLeakGuard(): void {
  const protectedPaths = resolveProtectedDbPaths();
  let baseline: Map<string, number> = new Map();

  beforeAll(() => {
    baseline = new Map(protectedPaths.map((p) => [p, snapshotFlowRunsCount(p)]));
  });

  afterAll(() => {
    const current = new Map(protectedPaths.map((p) => [p, snapshotFlowRunsCount(p)]));
    checkNoDriftDbGrowth(baseline, current);
  });
}
