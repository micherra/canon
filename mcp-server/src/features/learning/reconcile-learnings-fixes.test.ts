/**
 * Tests for 3 `reconcile_learnings` fix-review round 2 fixes (adversarial
 * review + security assessment on the ADR-0048 tool). Split out from
 * `reconcile-learnings.test.ts` to keep that file under the line-count lint
 * budget — see its own top-level comment for the base test suite.
 *
 * Fix A: `-n 1` creation-masking — a target CREATED by an older commit must
 *   reconcile even when a NEWER, unrelated commit later churns the same
 *   file. The single-most-recent-commit view (`latestCommitSince`) alone
 *   only ever sees the newer commit and would (wrongly) conclude the target
 *   was never created, orphaning the proposal forever for the
 *   created-then-churned subclass.
 *
 * Fix C: malformed `created` guard — a non-date-only, non-full-timestamp
 *   `created` value (e.g. "soon") must fall back to the full-precision
 *   dir-timestamp rather than reach `git log --since` verbatim, where git's
 *   approxidate parser would silently mis-parse it.
 *
 * Fix D: re-containment of the resolved target under `project_dir` — a
 *   `target_path` escaping via `..` segments must not be resolved (closes a
 *   path-traversal existence oracle, security LOW finding).
 */

import { describe, expect, it } from "vitest";
import {
  type ReconcileFsSeam,
  type ReconcileGitSeam,
  reconcileLearnings,
} from "./reconcile-learnings.ts";

const PROJECT_DIR = "/fake/project";

type FakeDirEntry = { name: string; isDirectory: boolean };

function makeFakeFs(opts: {
  dirs: Record<string, FakeDirEntry[]>;
  files: Record<string, string>;
  existingPaths?: Set<string>;
}): ReconcileFsSeam & {
  renamed: Array<{ from: string; to: string }>;
  appended: Array<{ path: string; data: string }>;
} {
  const renamed: Array<{ from: string; to: string }> = [];
  const appended: Array<{ path: string; data: string }> = [];

  return {
    appended,
    renamed,
    async readDir(path: string) {
      return opts.dirs[path] ?? [];
    },
    async readFile(path: string) {
      const content = opts.files[path];
      if (content === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return content;
    },
    async fileExists(path: string) {
      if (opts.existingPaths) return opts.existingPaths.has(path);
      return path in opts.files;
    },
    async mkdir() {
      // no-op — these tests don't assert on mkdir calls
    },
    async rename(from: string, to: string) {
      renamed.push({ from, to });
    },
    async appendFile(path: string, data: string) {
      appended.push({ path, data });
    },
  };
}

/** Single-evidence fake — mirrors the base test file's `makeFakeGit`. */
function makeFakeGit(
  hasCommit: boolean,
  opts: { hash?: string; createdFile?: boolean; message?: string } = {},
): ReconcileGitSeam {
  const { hash = "abc1234", createdFile = false, message = "" } = opts;
  return {
    creationCommitSince: () =>
      hasCommit && createdFile ? { createdFile: true, hash, message } : null,
    latestCommitSince: () => (hasCommit ? { createdFile, hash, message } : null),
  };
}

/**
 * Extended two-evidence fake (Fix A testability): models an OLDER creating
 * commit and a NEWER unrelated modify commit as fully independent seam
 * responses — the shape the single-`CommitEvidence`-return `latestCommitSince`
 * alone could never represent (it only ever returns the single most recent
 * commit). `creation`/`modify` are each independently nullable.
 */
function makeFakeGitTwoEvidence(opts: {
  creation?: { hash: string; message?: string } | null;
  modify?: { hash: string; message?: string } | null;
}): ReconcileGitSeam {
  const { creation = null, modify = null } = opts;
  return {
    creationCommitSince: () =>
      creation ? { createdFile: true, hash: creation.hash, message: creation.message ?? "" } : null,
    latestCommitSince: () =>
      modify ? { createdFile: false, hash: modify.hash, message: modify.message ?? "" } : null,
  };
}

const ROOT = `${PROJECT_DIR}/.canon/proposed-learnings`;
const TS_DIR = "2026-05-29T22-00-00Z";
const TS_DIR_PATH = `${ROOT}/${TS_DIR}`;

function actionableProposal(targetPath: string, type = "new-convention"): string {
  return [
    "---",
    "id: sug_TEST1",
    `type: ${type}`,
    `target_path: "${targetPath}"`,
    "created: 2026-05-29",
    "---",
    "",
    "## Proposal",
  ].join("\n");
}

describe("reconcileLearnings — fix-review round 2", () => {
  // ---------------------------------------------------------------------
  // Fix A — `-n 1` creation-masking: an OLDER commit that CREATED the target
  // is sufficient evidence on its own, even when a NEWER unrelated commit
  // later churns the same file. The old single-most-recent-commit check
  // would see only the newer churn commit and (wrongly) treat the target as
  // never-created, orphaning the proposal forever.
  // ---------------------------------------------------------------------

  it("(n) created@T1 + unrelated modify@T2 (newer) reconciles via the creation probe, regardless of later churn", async () => {
    const targetPath = "principles/conventions/some-convention.md";
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: TS_DIR, isDirectory: true }],
        [TS_DIR_PATH]: [{ name: "sug_TEST1-fixture.md", isDirectory: false }],
      },
      files: {
        [`${TS_DIR_PATH}/sug_TEST1-fixture.md`]: actionableProposal(targetPath, "new-convention"),
      },
      existingPaths: new Set([`${PROJECT_DIR}/${targetPath}`]),
    });
    // Older creation (T1) + a newer, unrelated churn commit (T2). The most-
    // recent-commit-only view (`latestCommitSince`) sees ONLY the churn
    // commit and would never learn the target was ever created.
    const git = makeFakeGitTwoEvidence({
      creation: { hash: "create1" },
      modify: { hash: "churn2", message: "chore: unrelated churn to a frequently-edited file" },
    });

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(1);
    expect(result.reconciled[0].commit).toBe("create1"); // creation evidence wins, not the churn commit
    expect(fs.renamed).toHaveLength(1);
  });

  it("(o) pure-modify target (no post-proposal creation) + unrelated commit stays pending — fix A must not weaken fix 3's relevance gate", async () => {
    const targetPath = "principles/conventions/some-convention.md";
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: TS_DIR, isDirectory: true }],
        [TS_DIR_PATH]: [{ name: "sug_TEST1-fixture.md", isDirectory: false }],
      },
      files: {
        [`${TS_DIR_PATH}/sug_TEST1-fixture.md`]: actionableProposal(targetPath, "severity-change"),
      },
      existingPaths: new Set([`${PROJECT_DIR}/${targetPath}`]),
    });
    // No creation commit at all (target existed before the proposal) — only
    // an unrelated modify. Must still stay pending.
    const git = makeFakeGitTwoEvidence({
      creation: null,
      modify: { hash: "churn3", message: "chore: unrelated churn to a frequently-edited file" },
    });

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(0);
    expect(fs.renamed).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // Fix C — malformed `created` guard: a non-date-only, non-full-timestamp
  // `created` value (e.g. "soon") must not be handed verbatim to
  // `git log --since`, where git's approxidate would silently mis-parse it.
  // ---------------------------------------------------------------------

  it("(p) malformed created value falls back to the full-precision dir-timestamp instead of reaching git verbatim", async () => {
    const targetPath = "principles/conventions/some-convention.md";
    const raw = [
      "---",
      "id: sug_TEST1",
      "type: new-convention",
      `target_path: "${targetPath}"`,
      "created: soon",
      "---",
      "",
      "## Proposal",
    ].join("\n");
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: TS_DIR, isDirectory: true }],
        [TS_DIR_PATH]: [{ name: "sug_TEST1-fixture.md", isDirectory: false }],
      },
      files: { [`${TS_DIR_PATH}/sug_TEST1-fixture.md`]: raw },
      existingPaths: new Set([`${PROJECT_DIR}/${targetPath}`]),
    });
    let sinceIsoSeen: string | null = null;
    const git: ReconcileGitSeam = {
      creationCommitSince: (_projectDir, _targetPath, sinceIso) => {
        sinceIsoSeen = sinceIso;
        return { createdFile: true, hash: "deadbeef", message: "" };
      },
      latestCommitSince: () => null,
    };

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, { fs, git });

    expect(result.ok).toBe(true);
    // TS_DIR is "2026-05-29T22-00-00Z" -> real-instant ISO "2026-05-29T22:00:00Z".
    // A malformed "soon" must never reach the git seam verbatim.
    expect(sinceIsoSeen).toBe("2026-05-29T22:00:00Z");
  });

  // ---------------------------------------------------------------------
  // Fix D — re-containment of the resolved target under project_dir: a
  // `target_path` escaping project_dir via `..` segments must not be
  // resolved (path-traversal existence oracle, security LOW finding).
  // ---------------------------------------------------------------------

  it("(q) a `..`-escaping target_path is not resolved/reconciled (path-traversal containment)", async () => {
    const escapingTarget = "../../../../etc/hosts";
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: TS_DIR, isDirectory: true }],
        [TS_DIR_PATH]: [{ name: "sug_TEST1-fixture.md", isDirectory: false }],
      },
      files: {
        [`${TS_DIR_PATH}/sug_TEST1-fixture.md`]: actionableProposal(escapingTarget),
      },
      // Pretend the escaping path "exists" — if containment were missing,
      // this would let the proposal reconcile via the escape.
      existingPaths: new Set(["/etc/hosts"]),
    });
    const git = makeFakeGit(true, { createdFile: true, hash: "deadbeef" });

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(0);
    expect(fs.renamed).toHaveLength(0);
    expect(result.skipped.some((s) => s.file.includes("sug_TEST1-fixture.md"))).toBe(true);
  });
});
