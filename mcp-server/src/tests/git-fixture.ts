/**
 * Shared git repo fixture for tests that need a real, invocable git repository.
 *
 * Consolidates the four duplicated `initGitRepo` helpers previously copy-pasted
 * across `init-workspace-worktree.test.ts`, `init-workspace-task-identity.test.ts`,
 * `tail-enforcement-journal-session.test.ts`, and `kg-pipeline.test.ts`.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Initialize a real git repo with one commit in `dir`. Returns the HEAD sha,
 * suitable for use as `base_commit` in `initWorkspaceFlow` calls.
 */
// canon:allow-unwired: test-only fixture, referenced exclusively from *.test.ts files (56 call sites across 11 test files); dead-wire-gate.sh deliberately excludes *.test.ts from reference counting
export function initGitFixtureRepo(dir: string): string {
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });

  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" });
  return result.stdout.trim();
}
