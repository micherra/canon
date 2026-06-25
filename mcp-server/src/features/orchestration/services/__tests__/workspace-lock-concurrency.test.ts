/**
 * Real-FS, multi-process concurrency test for workspace-lock.ts.
 *
 * Distinct from workspace-lock.test.ts (seam-driven, single-process unit tests):
 * this spawns genuinely-concurrent OS processes that race on the actual
 * filesystem, with no test seam involved. It asserts the compare-and-acquire
 * exclusivity invariant directly and would FAIL against an unconditional-overwrite
 * reclaim (which lets every racer "win" and silently last-write-wins the lock).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCK_TTL_MS, readLock } from "../workspace-lock.ts";

// mcp-server dir (cwd for tsx resolution) and the source module path.
// __tests__ → services → orchestration → features → src → mcp-server (5 ups).
const testDir = dirname(fileURLToPath(import.meta.url));
const modulePath = join(testDir, "..", "workspace-lock.ts");
const mcpServerDir = join(testDir, "..", "..", "..", "..", "..");

type Reclaimer = { kind: Promise<string>; kill: () => void };

/**
 * Start acquireLock for `sid` in a separate OS process. The child prints its
 * outcome kind then stays alive (so its holder PID does NOT die and trigger a
 * serial dead-PID reclaim by the next racer — in production the daemon PID stays
 * alive). The caller kills every child only AFTER all outcomes are in.
 */
function startReclaimer(runnerPath: string, lockDir: string, sid: string): Reclaimer {
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, lockDir, sid], {
    cwd: mcpServerDir,
  });
  const kind = new Promise<string>((resolve, reject) => {
    let buf = "";
    let err = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(buf.slice(0, nl).trim());
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      // null code = killed by signal (expected teardown). Non-zero = real crash.
      if (code !== 0 && code !== null) reject(new Error(`reclaimer ${sid} exited ${code}: ${err}`));
    });
  });
  return { kill: () => child.kill(), kind };
}

describe("acquireLock — real-FS concurrent-reclaim exclusivity (P1 #1)", () => {
  it("lets exactly one of N concurrent OS processes own the lock; the rest gate", async () => {
    const raceDir = mkdtempSync(join(tmpdir(), "workspace-lock-race-"));
    const runnerPath = join(raceDir, "race-runner.ts");
    writeFileSync(
      runnerPath,
      [
        `import { acquireLock } from ${JSON.stringify(modulePath)};`,
        `const o = acquireLock(process.argv[2], { session_id: process.argv[3], job_id: process.argv[3] });`,
        `process.stdout.write(o.kind + "\\n");`,
        // Stay alive so the holder PID survives until the parent tears us down.
        `setInterval(() => {}, 1 << 30);`,
        "",
      ].join("\n"),
      "utf-8",
    );

    // One shared stale lock all racers will contend to reclaim.
    const staleStarted = new Date(Date.now() - DEFAULT_LOCK_TTL_MS - 60_000).toISOString();
    writeFileSync(
      join(raceDir, ".lock"),
      JSON.stringify({
        session_id: "old",
        job_id: "old",
        pid: 999999999,
        started_at: staleStarted,
      }),
      "utf-8",
    );

    const n = 5;
    const reclaimers = Array.from({ length: n }, (_, i) =>
      startReclaimer(runnerPath, raceDir, `sess-${i}`),
    );
    try {
      const kinds = await Promise.all(reclaimers.map((r) => r.kind));
      const winners = kinds.filter((k) => k === "reclaimed" || k === "acquired");
      const gated = kinds.filter((k) => k === "gated");
      expect(winners).toHaveLength(1); // exactly one owner — no co-drive
      expect(gated).toHaveLength(n - 1); // everyone else gated
      expect(readLock(raceDir)).not.toBeNull(); // on-disk lock is a valid record
    } finally {
      for (const r of reclaimers) r.kill();
      await rm(raceDir, { force: true, recursive: true });
    }
  }, 20000);
});
