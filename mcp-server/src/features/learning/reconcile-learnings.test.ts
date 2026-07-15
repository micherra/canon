import { describe, expect, it, vi } from "vitest";
import {
  FRESHNESS_DAYS,
  type ReconcileFsSeam,
  type ReconcileGitSeam,
  reconcileLearnings,
} from "./reconcile-learnings.ts";

const PROJECT_DIR = "/fake/project";

// ---------------------------------------------------------------------------
// Fake fs/git seams — an in-memory filesystem model keyed by absolute path.
// ---------------------------------------------------------------------------

type FakeDirEntry = { name: string; isDirectory: boolean };

function makeFakeFs(opts: {
  dirs: Record<string, FakeDirEntry[]>;
  files: Record<string, string>;
  existingPaths?: Set<string>;
}): ReconcileFsSeam & {
  renamed: Array<{ from: string; to: string }>;
  appended: Array<{ path: string; data: string }>;
  mkdirs: string[];
} {
  const renamed: Array<{ from: string; to: string }> = [];
  const appended: Array<{ path: string; data: string }> = [];
  const mkdirs: string[] = [];

  return {
    appended,
    mkdirs,
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
    async mkdir(path: string) {
      mkdirs.push(path);
    },
    async rename(from: string, to: string) {
      renamed.push({ from, to });
    },
    async appendFile(path: string, data: string) {
      appended.push({ path, data });
    },
  };
}

/**
 * `createdFile: true` models a commit that CREATED targetPath — sufficient
 * evidence on its own (creation is unambiguous). `createdFile: false` (the
 * default) models a commit that only MODIFIED an already-existing target —
 * this requires the relevance check (`message` content-linkage) to reconcile.
 *
 * `creationCommitSince` mirrors the same single scenario: when the fake
 * models a creation (`createdFile: true`), the dedicated creation probe
 * finds it too (a real creating commit IS a creation, regardless of which
 * seam method asks). When the fake models a pure modify, the creation probe
 * correctly finds nothing.
 */
function makeFakeGit(
  hasCommit: boolean,
  opts: { hash?: string; createdFile?: boolean; message?: string } = {},
): ReconcileGitSeam {
  const { hash = "abc1234", createdFile = false, message = "" } = opts;
  return {
    creationCommitSince: vi.fn(() =>
      hasCommit && createdFile ? { createdFile: true, hash, message } : null,
    ),
    latestCommitSince: vi.fn(() => (hasCommit ? { createdFile, hash, message } : null)),
  };
}

/**
 * Time-aware fake for the date-only `created` boundary tests: returns a
 * commit only when `commitIso` is at-or-after the requested `sinceIso`,
 * mirroring `git log --since` semantics. Both seam methods apply the same
 * time check — these tests probe the `--since` boundary, not the
 * creation-vs-modify distinction.
 */
function makeTimeAwareFakeGit(commitIso: string, hash = "abc1234"): ReconcileGitSeam {
  const evidenceIfDue = (sinceIso: string) =>
    new Date(commitIso) >= new Date(sinceIso) ? { createdFile: true, hash, message: "" } : null;
  return {
    creationCommitSince: vi.fn((_projectDir: string, _targetPath: string, sinceIso: string) =>
      evidenceIfDue(sinceIso),
    ),
    latestCommitSince: vi.fn((_projectDir: string, _targetPath: string, sinceIso: string) =>
      evidenceIfDue(sinceIso),
    ),
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

function informationalProposal(): string {
  return ["---", "id: watch_TEST1", "type: watch", "---", "", "## Watch"].join("\n");
}

describe("reconcileLearnings", () => {
  it("(a) happy path — reconciles a pending actionable proposal with a post-proposal commit", async () => {
    const targetPath = "principles/conventions/some-convention.md";
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: TS_DIR, isDirectory: true }],
        [TS_DIR_PATH]: [{ name: "sug_TEST1-fixture.md", isDirectory: false }],
      },
      files: {
        [`${TS_DIR_PATH}/sug_TEST1-fixture.md`]: actionableProposal(targetPath),
      },
      existingPaths: new Set([`${PROJECT_DIR}/${targetPath}`]),
    });
    // new-convention: the target is CREATED by this commit — creation alone
    // is sufficient evidence (Fix 3 relevance gate does not apply).
    const git = makeFakeGit(true, { createdFile: true, hash: "deadbeef" });

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(1);
    expect(result.reconciled[0].file).toBe("sug_TEST1-fixture.md");
    expect(result.reconciled[0].commit).toBe("deadbeef");
    expect(result.archived).toHaveLength(0);
    expect(result.flagged_stale).toHaveLength(0);

    // Moved via rename, never via a destructive delete.
    expect(fs.renamed).toHaveLength(1);
    expect(fs.renamed[0].from).toBe(`${TS_DIR_PATH}/sug_TEST1-fixture.md`);
    expect(fs.renamed[0].to).toBe(`${TS_DIR_PATH}/applied/sug_TEST1-fixture.md`);

    // learning.jsonl appended (never rewritten).
    expect(fs.appended).toHaveLength(1);
    const appendedLine = fs.appended[0];
    expect(appendedLine.path).toBe(`${PROJECT_DIR}/.canon/learning.jsonl`);
    const parsed = JSON.parse(appendedLine.data.trim());
    expect(parsed.action).toBe("accepted");
    expect(parsed.proposal_id).toBe("sug_TEST1-fixture.md");
  });

  it("(b) idempotent — a second run over the post-reconcile state is a zero-mutation no-op", async () => {
    const targetPath = "principles/conventions/some-convention.md";
    // Simulates state AFTER run (a): the proposal file already lives under applied/,
    // so it is no longer a top-level pending file in the timestamped dir.
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: TS_DIR, isDirectory: true }],
        [TS_DIR_PATH]: [{ name: "applied", isDirectory: true }],
      },
      files: {},
      existingPaths: new Set([`${PROJECT_DIR}/${targetPath}`]),
    });
    const git = makeFakeGit(true, { createdFile: true, hash: "deadbeef" });

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(0);
    expect(result.archived).toHaveLength(0);
    expect(fs.renamed).toHaveLength(0);
    expect(fs.appended).toHaveLength(0);
  });

  it("(c) conservative — target exists but has no post-proposal commit -> NOT moved", async () => {
    const targetPath = "principles/conventions/some-convention.md";
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: TS_DIR, isDirectory: true }],
        [TS_DIR_PATH]: [{ name: "sug_TEST1-fixture.md", isDirectory: false }],
      },
      files: {
        [`${TS_DIR_PATH}/sug_TEST1-fixture.md`]: actionableProposal(targetPath),
      },
      existingPaths: new Set([`${PROJECT_DIR}/${targetPath}`]),
    });
    const git = makeFakeGit(false); // no commit post-dates the proposal

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(0);
    expect(fs.renamed).toHaveLength(0);
    expect(fs.appended).toHaveLength(0);
  });

  it("(d) fail-open — a seam throw yields { ok: false } with no partial mutation", async () => {
    const targetPath = "principles/conventions/some-convention.md";
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: TS_DIR, isDirectory: true }],
        [TS_DIR_PATH]: [{ name: "sug_TEST1-fixture.md", isDirectory: false }],
      },
      files: {
        [`${TS_DIR_PATH}/sug_TEST1-fixture.md`]: actionableProposal(targetPath),
      },
      existingPaths: new Set([`${PROJECT_DIR}/${targetPath}`]),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const git: ReconcileGitSeam = {
      creationCommitSince: () => null, // no creation evidence — falls through to latestCommitSince
      latestCommitSince: () => {
        throw new Error("simulated git failure");
      },
    };

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(false);
    expect(fs.renamed).toHaveLength(0);
    expect(fs.appended).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("(e) freshness — a backdated informational-only set is archived to stale/", async () => {
    const OLD_TS_DIR = "2020-01-01T00-00-00Z"; // far older than FRESHNESS_DAYS
    const oldDirPath = `${ROOT}/${OLD_TS_DIR}`;
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: OLD_TS_DIR, isDirectory: true }],
        [oldDirPath]: [{ name: "watch_OLD1-fixture.md", isDirectory: false }],
      },
      files: {
        [`${oldDirPath}/watch_OLD1-fixture.md`]: informationalProposal(),
      },
    });
    const git = makeFakeGit(false);

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.archived).toHaveLength(1);
    expect(result.archived[0].file).toBe("watch_OLD1-fixture.md");
    expect(result.flagged_stale).toHaveLength(0);
    expect(fs.renamed).toEqual([
      {
        from: `${oldDirPath}/watch_OLD1-fixture.md`,
        to: `${oldDirPath}/stale/watch_OLD1-fixture.md`,
      },
    ]);
    const parsed = JSON.parse(fs.appended[0].data.trim());
    expect(parsed.action).toBe("archived");
  });

  it("(f) freshness — a backdated set with an actionable survivor is flagged, not archived", async () => {
    const OLD_TS_DIR = "2020-01-01T00-00-00Z";
    const oldDirPath = `${ROOT}/${OLD_TS_DIR}`;
    const targetPath = "principles/conventions/some-convention.md";
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: OLD_TS_DIR, isDirectory: true }],
        [oldDirPath]: [{ name: "sug_OLD1-fixture.md", isDirectory: false }],
      },
      files: {
        [`${oldDirPath}/sug_OLD1-fixture.md`]: actionableProposal(targetPath),
      },
      existingPaths: new Set([`${PROJECT_DIR}/${targetPath}`]),
    });
    // No post-proposal commit — the actionable proposal survives reconcile (stays pending).
    const git = makeFakeGit(false);

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.archived).toHaveLength(0);
    expect(result.flagged_stale).toHaveLength(1);
    expect(result.flagged_stale[0].dir).toBe(OLD_TS_DIR);
    expect(result.flagged_stale[0].actionable_survivors).toEqual(["sug_OLD1-fixture.md"]);
    expect(fs.renamed).toHaveLength(0);
    expect(fs.appended).toHaveLength(0);
  });

  it("(g) dry_run — returns the computed plan with zero mutations", async () => {
    const targetPath = "principles/conventions/some-convention.md";
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: TS_DIR, isDirectory: true }],
        [TS_DIR_PATH]: [{ name: "sug_TEST1-fixture.md", isDirectory: false }],
      },
      files: {
        [`${TS_DIR_PATH}/sug_TEST1-fixture.md`]: actionableProposal(targetPath),
      },
      existingPaths: new Set([`${PROJECT_DIR}/${targetPath}`]),
    });
    const git = makeFakeGit(true, { createdFile: true, hash: "deadbeef" });

    const result = await reconcileLearnings(
      { project_dir: PROJECT_DIR, dry_run: true },
      PROJECT_DIR,
      { fs, git },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(1);
    expect(fs.renamed).toHaveLength(0);
    expect(fs.appended).toHaveLength(0);
    expect(fs.mkdirs).toHaveLength(0);
  });

  it("rejects a path-escape project_dir input", async () => {
    const result = await reconcileLearnings({ project_dir: "/fake/../etc" }, PROJECT_DIR);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-positive freshness_days input", async () => {
    const result = await reconcileLearnings(
      { project_dir: PROJECT_DIR, freshness_days: 0 },
      PROJECT_DIR,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a project_dir outside the resolved session scope, with zero mutations (validate-at-trust-boundaries)", async () => {
    const outsideDir = "/fake/outside-project";
    const fs = makeFakeFs({ dirs: {}, files: {} });
    const git = makeFakeGit(false);

    const result = await reconcileLearnings({ project_dir: outsideDir }, PROJECT_DIR, {
      fs,
      git,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(fs.renamed).toHaveLength(0);
    expect(fs.appended).toHaveLength(0);
  });

  it("never touches a loose top-level proposal file (PROBE-FINDINGS P4 scope)", async () => {
    const fs = makeFakeFs({
      dirs: {
        // A loose file sits directly under proposed-learnings/ (not inside a
        // timestamped dir) — it must never be enumerated as a pending set.
        [ROOT]: [{ name: "sug_LOOSE1-fixture.md", isDirectory: false }],
      },
      files: {
        [`${ROOT}/sug_LOOSE1-fixture.md`]: actionableProposal("principles/conventions/x.md"),
      },
    });
    const git = makeFakeGit(true, { createdFile: true, hash: "deadbeef" });

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(0);
    expect(fs.renamed).toHaveLength(0);
  });

  it("exports a documented FRESHNESS_DAYS default of 30", () => {
    expect(FRESHNESS_DAYS).toBe(30);
  });

  // ---------------------------------------------------------------------
  // Fix 1 — transaction boundary: the learning.jsonl audit line for a
  // successfully-moved proposal must exist even if a LATER rename in the
  // same apply pass throws.
  // ---------------------------------------------------------------------

  it("(h) transaction boundary — a rename that throws mid-loop still leaves the audit line for the earlier, already-moved proposal", async () => {
    const targetPath = "principles/conventions/some-convention.md";
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: TS_DIR, isDirectory: true }],
        [TS_DIR_PATH]: [
          { name: "sug_TEST1-fixture.md", isDirectory: false },
          { name: "sug_TEST2-fixture.md", isDirectory: false },
        ],
      },
      files: {
        [`${TS_DIR_PATH}/sug_TEST1-fixture.md`]: actionableProposal(targetPath),
        [`${TS_DIR_PATH}/sug_TEST2-fixture.md`]: actionableProposal(targetPath),
      },
      existingPaths: new Set([`${PROJECT_DIR}/${targetPath}`]),
    });
    const git = makeFakeGit(true, { createdFile: true, hash: "deadbeef" });

    // Simulate a crash on the SECOND rename. If append-after-every-rename
    // (per-file interleaving) is real, the FIRST proposal's audit line must
    // already be on disk before this throw propagates.
    const originalRename = fs.rename.bind(fs);
    let renameCalls = 0;
    fs.rename = async (from: string, to: string) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error("simulated crash mid-apply");
      return originalRename(from, to);
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(false); // the crash propagates to the fail-open handler
    expect(fs.renamed).toHaveLength(1); // only the first rename succeeded
    expect(fs.appended).toHaveLength(1); // its audit line must already be written
    const parsed = JSON.parse(fs.appended[0].data.trim());
    expect(parsed.proposal_id).toBe("sug_TEST1-fixture.md");
    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------
  // Fix 2 — date-only `created` intra-day boundary: a date-only `created`
  // must fall back to the full-precision dir-timestamp, not a lossy midnight.
  // ---------------------------------------------------------------------

  it("(i) date-only created — a same-day-earlier commit does NOT falsely reconcile a date-only-created proposal", async () => {
    const targetPath = "principles/conventions/some-convention.md";
    // TS_DIR is 2026-05-29T22-00-00Z (10pm) — the proposal's REAL instant.
    // Its frontmatter `created` is date-only ("2026-05-29"). A commit landed
    // earlier the same day (08:00 UTC) — genuinely BEFORE the proposal, but
    // a lossy midnight-parse of the date-only value would treat it as after.
    const fs = makeFakeFs({
      dirs: {
        [ROOT]: [{ name: TS_DIR, isDirectory: true }],
        [TS_DIR_PATH]: [{ name: "sug_TEST1-fixture.md", isDirectory: false }],
      },
      files: {
        [`${TS_DIR_PATH}/sug_TEST1-fixture.md`]: actionableProposal(targetPath),
      },
      existingPaths: new Set([`${PROJECT_DIR}/${targetPath}`]),
    });
    const git = makeTimeAwareFakeGit("2026-05-29T08:00:00Z");

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(0);
    expect(fs.renamed).toHaveLength(0);
  });

  it("(j) full-timestamp created is used verbatim, not overridden by the dir-timestamp fallback", async () => {
    const targetPath = "principles/conventions/some-convention.md";
    // created carries a full timestamp (23:00) LATER than the dir timestamp
    // (22:00). A commit at 22:30 is after the dir-timestamp but before the
    // full `created` value — it must NOT reconcile, proving the literal
    // `created` timestamp won (not the dir-timestamp fallback).
    const raw = [
      "---",
      "id: sug_TEST1",
      "type: new-convention",
      `target_path: "${targetPath}"`,
      "created: 2026-05-29T23:00:00Z",
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
    const git = makeTimeAwareFakeGit("2026-05-29T22:30:00Z");

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // Fix 3 — evidence-predicate relevance gap: for a target that already
  // existed before the proposal (commit only MODIFIED it), an unrelated
  // commit must not count as evidence. File-CREATION remains sufficient on
  // its own, regardless of message content.
  // ---------------------------------------------------------------------

  it("(k) relevance — existing-file target + unrelated commit is NOT reconciled", async () => {
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
    // Commit exists and touches the (pre-existing) target, but its message
    // has no content-linkage to the proposal or the target — an unrelated
    // churn commit must not count as evidence.
    const git = makeFakeGit(true, {
      createdFile: false,
      hash: "deadbeef",
      message: "chore: fix a typo elsewhere in the file",
    });

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(0);
    expect(fs.renamed).toHaveLength(0);
    expect(result.skipped.some((s) => s.file.includes("sug_TEST1-fixture.md"))).toBe(true);
  });

  it("(l) relevance — existing-file target + a commit referencing the proposal id IS reconciled", async () => {
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
    const git = makeFakeGit(true, {
      createdFile: false,
      hash: "deadbeef",
      message: "docs(principles): apply sug_TEST1 severity change",
    });

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(1);
    expect(result.reconciled[0].commit).toBe("deadbeef");
    expect(fs.renamed).toHaveLength(1);
  });

  it("(m) relevance — a new-file target CREATED by the commit reconciles regardless of message content", async () => {
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
    // File creation is sufficient evidence on its own — no id/principle
    // reference in the message, yet this still reconciles.
    const git = makeFakeGit(true, {
      createdFile: true,
      hash: "deadbeef",
      message: "chore: unrelated commit subject",
    });

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, PROJECT_DIR, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(1);
    expect(fs.renamed).toHaveLength(1);
  });

  // Fixes A, C, D (fix-review round 2 — creation-probe, malformed `created`
  // guard, target re-containment) live in reconcile-learnings-fixes.test.ts —
  // split out to keep this file under the line-count lint budget.
});
