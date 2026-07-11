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

function makeFakeGit(hasCommit: boolean, commitHash = "abc1234"): ReconcileGitSeam {
  return {
    latestCommitSince: vi.fn(() => (hasCommit ? commitHash : null)),
  };
}

const ROOT = `${PROJECT_DIR}/.canon/proposed-learnings`;
const TS_DIR = "2026-05-29T22-00-00Z";
const TS_DIR_PATH = `${ROOT}/${TS_DIR}`;

function actionableProposal(targetPath: string): string {
  return [
    "---",
    "id: sug_TEST1",
    "type: new-convention",
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
    const git = makeFakeGit(true, "deadbeef");

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, { fs, git });

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
    const git = makeFakeGit(true, "deadbeef");

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, { fs, git });

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

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, { fs, git });

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
      latestCommitSince: () => {
        throw new Error("simulated git failure");
      },
    };

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, { fs, git });

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

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, { fs, git });

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

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, { fs, git });

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
    const git = makeFakeGit(true, "deadbeef");

    const result = await reconcileLearnings(
      { project_dir: PROJECT_DIR, dry_run: true },
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
    const result = await reconcileLearnings({ project_dir: "/fake/../etc" });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-positive freshness_days input", async () => {
    const result = await reconcileLearnings({ project_dir: PROJECT_DIR, freshness_days: 0 });
    expect(result.ok).toBe(false);
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
    const git = makeFakeGit(true, "deadbeef");

    const result = await reconcileLearnings({ project_dir: PROJECT_DIR }, { fs, git });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.reconciled).toHaveLength(0);
    expect(fs.renamed).toHaveLength(0);
  });

  it("exports a documented FRESHNESS_DAYS default of 30", () => {
    expect(FRESHNESS_DAYS).toBe(30);
  });
});
