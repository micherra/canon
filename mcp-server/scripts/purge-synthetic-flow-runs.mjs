#!/usr/bin/env node
/**
 * purge-synthetic-flow-runs.mjs — safely delete synthetic test-fixture rows
 * from a `.canon/drift.db` `flow_runs` table.
 *
 * SYNOPSIS
 *   node scripts/purge-synthetic-flow-runs.mjs [dbPath] [--flow=<name>]
 *
 * ARGS
 *   dbPath      Optional path to the drift.db file. Defaults to
 *               `<repoRoot>/.canon/drift.db` (repo root resolved by walking
 *               up from this script's own location to the `.git` marker).
 *   --flow=NAME Optional flow name to target. Defaults to `test-flow`.
 *
 * SAFETY
 *   Before deleting anything, this script asserts that ZERO target rows look
 *   like real activity: `total_spawns > 0 OR total_duration_ms > 1000`. If any
 *   offending row is found, it is printed and the script exits non-zero
 *   WITHOUT deleting anything. This is a hard guard, not a warning.
 *
 *   The script is idempotent: running it a second time against an
 *   already-purged target deletes zero rows and exits 0.
 *
 * This script ships (committed, re-runnable). Any local run against a
 * gitignored `.canon/drift.db` does not ship — the DB file itself is not
 * tracked.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/** Walk up from `startDir` to the nearest ancestor containing a `.git` marker. */
function findRepoRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `purge-synthetic-flow-runs: could not locate repo root (.git marker) walking up from ${startDir}`,
      );
    }
    dir = parent;
  }
}

function parseArgs(argv) {
  let dbPathArg;
  let flow = "test-flow";
  for (const arg of argv) {
    if (arg.startsWith("--flow=")) {
      flow = arg.slice("--flow=".length);
    } else if (!arg.startsWith("--")) {
      dbPathArg = arg;
    }
  }
  return { dbPathArg, flow };
}

function main() {
  const { dbPathArg, flow } = parseArgs(process.argv.slice(2));

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(thisDir);
  const dbPath = dbPathArg ? resolve(dbPathArg) : join(repoRoot, ".canon", "drift.db");

  if (!existsSync(dbPath)) {
    console.log(`purge-synthetic-flow-runs: ${dbPath} does not exist — nothing to purge.`);
    process.exit(0);
  }

  const db = new Database(dbPath);
  try {
    const preTotal = db.prepare("SELECT COUNT(*) as c FROM flow_runs").get().c;
    const target = db.prepare("SELECT COUNT(*) as c FROM flow_runs WHERE flow = ?").get(flow).c;

    console.log(`purge-synthetic-flow-runs: db=${dbPath} flow=${flow}`);
    console.log(`  pre-count: total=${preTotal}, flow='${flow}'=${target}`);

    if (target === 0) {
      console.log("  nothing to purge for this flow — idempotent no-op.");
      process.exit(0);
    }

    // GUARD: refuse to delete any row that looks like real activity.
    const offenders = db
      .prepare(
        "SELECT run_id, flow, total_spawns, total_duration_ms FROM flow_runs " +
          "WHERE flow = ? AND (total_spawns > 0 OR total_duration_ms > 1000)",
      )
      .all(flow);

    if (offenders.length > 0) {
      console.error(
        `purge-synthetic-flow-runs: REFUSING to delete — ${offenders.length} row(s) for ` +
          `flow='${flow}' look like real activity (total_spawns>0 OR total_duration_ms>1000):`,
      );
      for (const row of offenders) {
        console.error(`  run_id=${row.run_id} total_spawns=${row.total_spawns} total_duration_ms=${row.total_duration_ms}`);
      }
      console.error("No rows deleted. Refine --flow or investigate before re-running.");
      process.exit(1);
    }

    const result = db.prepare("DELETE FROM flow_runs WHERE flow = ?").run(flow);
    const postTotal = db.prepare("SELECT COUNT(*) as c FROM flow_runs").get().c;

    if (result.changes !== target) {
      console.error(
        `purge-synthetic-flow-runs: ASSERTION FAILED — expected to delete ${target} rows, ` +
          `deleted ${result.changes}. Aborting (transaction already committed by better-sqlite3 ` +
          `.run(); investigate immediately).`,
      );
      process.exit(1);
    }
    if (postTotal !== preTotal - target) {
      console.error(
        `purge-synthetic-flow-runs: ASSERTION FAILED — expected post-total ${preTotal - target}, ` +
          `got ${postTotal}.`,
      );
      process.exit(1);
    }

    console.log(`  deleted: ${result.changes} row(s)`);
    console.log(`  post-count: total=${postTotal}, flow='${flow}'=0`);
  } finally {
    db.close();
  }
}

main();
