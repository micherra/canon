/**
 * t2-recorder-trigger — fire-and-forget trigger for the T2 live-forward-
 * checker recorder (ADR-0065).
 *
 * Replaces the prose "orchestrator runs a Bash command" contract with a
 * mechanical server-side side-effect of the canonical `write_review` call:
 * write_review's app handler (`app/register-artifacts.ts`) calls
 * `triggerT2Recorder` after a successful, non-step-scoped review write.
 *
 * The recorder is an OBSERVATION instrument, never a gate (same class as
 * the evaluator gate). It must NEVER be able to affect the caller — a
 * missing `record.ts`/`tsx`/`npx` binary, a recorder crash, a non-zero
 * exit, or a hang must never change write_review's ToolResult or crash the
 * host process. This is a STRUCTURAL guarantee, not a convention — proven
 * by PROBE-FINDINGS.md Probe 3:
 *   - detached + stdio:"ignore" — the child does not inherit stdio and
 *     does not block on pipes.
 *   - a no-op 'error' listener — absorbs an async ENOENT/EACCES event
 *     before it can escalate to an uncaughtException on the host (Probe 3a
 *     is the failure this prevents; without a listener the host process
 *     exits non-zero).
 *   - `unref()` — the child keeps running after the host returns; the
 *     host does not wait for it (Probe 3c).
 *   - the whole call wrapped in try/catch — absorbs a synchronous spawn
 *     throw (e.g. an injected `spawnFn`, or a genuinely broken environment).
 *
 * Returns whether the recorder was DISPATCHED, not whether it SUCCEEDED —
 * success is intentionally unobservable from this boundary (d-t2fix-06):
 * firing must never depend on anything the caller does afterward.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type SpawnFn, spawnProcess } from "@platform/adapters/process-adapter.ts";

export type TriggerT2RecorderOptions = {
  /** Main-checkout root, resolved server-side (resolveScope) — never caller-supplied as --root (AC-4). */
  projectDir: string;
  /** Build worktree containing the reviewed diff. */
  worktree: string;
  /** Base commit sha the review diffed against. */
  base: string;
  slug: string;
  reviewId?: string;
};

/**
 * Spawn `record.ts` in the background. `spawnFn` defaults to the real
 * `spawnProcess` adapter; tests inject a fake to exercise the failure path
 * without touching a real process.
 *
 * Guards: an empty `base`/`worktree`/`slug`, or a non-existent `worktree`
 * dir, returns `false` WITHOUT spawning (validate-at-trust-boundaries) —
 * strictly no worse than the pre-ADR-0065 status quo.
 */
export function triggerT2Recorder(
  opts: TriggerT2RecorderOptions,
  spawnFn: SpawnFn = spawnProcess,
): boolean {
  try {
    const { projectDir, worktree, base, slug, reviewId } = opts;
    if (!base || !worktree || !slug || !existsSync(worktree)) return false;

    const mcpServerDir = join(projectDir, "mcp-server");
    const recordScript = join(mcpServerDir, "scripts", "t2-probe", "record.ts");
    // --head is deliberately omitted — the recorder resolves reviewed HEAD via
    // `git rev-parse HEAD` in the worktree, which IS the reviewed HEAD at this
    // call site because no fix commit has landed yet (DESIGN.md assumption 4).
    const args = [
      "tsx",
      recordScript,
      "--worktree",
      worktree,
      "--base",
      base,
      "--slug",
      slug,
      "--root",
      projectDir,
      ...(reviewId ? ["--review-id", reviewId] : []),
    ];

    const child = spawnFn("npx", args, { cwd: mcpServerDir, detached: true, stdio: "ignore" });
    child.on("error", () => {
      // Absorb an async spawn error (e.g. ENOENT) — without this listener it
      // escalates to an uncaughtException on the host (Probe 3a).
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
