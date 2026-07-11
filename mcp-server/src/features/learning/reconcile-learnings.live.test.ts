/**
 * Live end-to-end smoke test for `reconcileLearnings` (ADR-0048).
 *
 * `reconcile-learnings.test.ts` and `reconcile-learnings-fixes.test.ts` cover
 * the handler exhaustively against FAKE `ReconcileFsSeam`/`ReconcileGitSeam`
 * implementations. Those fakes model git's evidence predicate but never
 * invoke real git — the actual `--diff-filter=A` creation probe and
 * `--since`/`--name-status` queries in `defaultGitSeam` (reconcile-learnings.ts)
 * have zero coverage from a real `git log`/`git show` process.
 *
 * This file drives `reconcileLearnings` with NO seams argument — it falls
 * back to `defaultFsSeam` (real `node:fs/promises`) and `defaultGitSeam`
 * (real `gitExec` subprocess calls) — against a genuine temp git repository
 * built with real `git init`/`add`/`commit`. This is the integration
 * boundary the unit fakes cannot exercise (`agent-integration-boundary-check`).
 *
 * All proposal timestamps are computed relative to the real wall-clock `now`
 * at test-run time (not hardcoded dates) so the fixture never depends on when
 * this suite happens to run.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileLearnings } from "./reconcile-learnings.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(now: number, n: number): Date {
  return new Date(now - n * DAY_MS);
}

/** `2026-07-06T12:00:00.000Z` -> `2026-07-06T12-00-00Z` (the ts-dir naming convention). */
function toTsDirName(d: Date): string {
  return `${d.toISOString().split(".")[0]}Z`.replace(/:/g, "-");
}

/** Strips milliseconds — `git`'s date parser wants whole-second ISO 8601. */
function toGitDate(d: Date): string {
  return `${d.toISOString().split(".")[0]}Z`;
}

function runGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
}

async function initRepo(dir: string): Promise<void> {
  runGit(["init", "-q", "-b", "main"], dir);
  // Local-only config on the throwaway fixture repo — isolates the test from
  // the ambient user's global gpgsign/identity config, not a real Canon commit.
  runGit(["config", "user.email", "reconcile-live-test@example.com"], dir);
  runGit(["config", "user.name", "Reconcile Live Test"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
}

async function writeAndCommit(
  repoDir: string,
  relPath: string,
  content: string,
  opts: { message: string; date: Date },
): Promise<void> {
  const abs = join(repoDir, relPath);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
  runGit(["add", relPath], repoDir);
  const dateStr = toGitDate(opts.date);
  runGit(["commit", "-q", "-m", opts.message], repoDir, {
    GIT_AUTHOR_DATE: dateStr,
    GIT_COMMITTER_DATE: dateStr,
  });
}

function actionableProposal(id: string, type: string, targetPath: string): string {
  return [
    "---",
    `id: ${id}`,
    `type: ${type}`,
    `target_path: "${targetPath}"`,
    "---",
    "",
    "## Proposal",
  ].join("\n");
}

function informationalProposal(id: string): string {
  return ["---", `id: ${id}`, "type: watch", "---", "", "## Watch"].join("\n");
}

async function writeProposal(
  projectDir: string,
  tsDir: string,
  filename: string,
  content: string,
): Promise<string> {
  const dirPath = join(projectDir, ".canon", "proposed-learnings", tsDir);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = join(dirPath, filename);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

describe("reconcileLearnings — live fixture integration (real fs + real git, no seams)", () => {
  let projectDir: string;
  const now = Date.now();

  // ts-dir names for each scenario. All within the freshness window except STALE.
  const tsRecent = toTsDirName(daysAgo(now, 5));
  const tsStale = toTsDirName(daysAgo(now, 40));

  const proposedRoot = () => join(projectDir, ".canon", "proposed-learnings");
  const recentDir = () => join(proposedRoot(), tsRecent);
  const staleDir = () => join(proposedRoot(), tsStale);
  const learningJsonlPath = () => join(projectDir, ".canon", "learning.jsonl");

  beforeAll(async () => {
    projectDir = await fs.mkdtemp(join(tmpdir(), "reconcile-live-"));
    await initRepo(projectDir);

    // Commits below MUST be created in true chronological order (oldest
    // simulated date first). `git log --since` walks the parent chain from
    // HEAD backward and stops at the first commit older than the threshold,
    // assuming commit dates are monotonically non-increasing along that walk
    // — the same assumption every real git history satisfies by construction
    // (you cannot commit "in the past" after a later commit in real life). A
    // fixture that free-mixes simulated dates out of real creation order
    // breaks that assumption and makes `--since` silently skip commits that
    // are genuinely in range — this bit the first draft of this fixture.
    await writeAndCommit(projectDir, "README.md", "# fixture repo\n", {
      date: daysAgo(now, 20),
      message: "chore: init fixture repo",
    });

    // --- Scenario 3 setup: pure-modify target pre-exists BEFORE the proposal.
    await writeAndCommit(projectDir, "target/pure-modify.md", "# pre-existing convention\n", {
      date: daysAgo(now, 10),
      message: "docs(principles): add pure-modify convention (pre-existing)",
    });

    // --- Scenario 2 setup (C1): created-then-churned's CREATING commit.
    await writeAndCommit(projectDir, "target/created-then-churned.md", "# convention\n", {
      date: daysAgo(now, 4),
      message: "docs(principles): add created-then-churned convention",
    });

    // --- Scenario 1 setup: creation-reconciles target created after the proposal.
    await writeAndCommit(projectDir, "target/creation-reconciles.md", "# convention\n", {
      date: daysAgo(now, 3),
      message: "docs(principles): add creation-reconciles convention",
    });

    // --- Scenario 4 setup: informational-target's commit (evidence irrelevant).
    await writeAndCommit(projectDir, "target/informational-target.md", "# watched thing\n", {
      date: daysAgo(now, 3),
      message: "docs(principles): add informational-target",
    });

    // --- Scenario 2 setup (C2): a LATER, unrelated churn commit on the same
    // file C1 created. The --diff-filter=A creation probe must still find C1
    // despite this newer, unrelated modify (the adversarial fix case).
    await writeAndCommit(projectDir, "target/created-then-churned.md", "# convention (edited)\n", {
      date: daysAgo(now, 2),
      message: "chore: unrelated formatting churn",
    });

    // --- Scenario 3 setup: an unrelated modify lands after the proposal, but
    // its message does not reference the proposal — no content-linkage.
    await writeAndCommit(
      projectDir,
      "target/pure-modify.md",
      "# pre-existing convention (tweak)\n",
      {
        date: daysAgo(now, 2),
        message: "chore: fix a typo elsewhere in the file",
      },
    );

    // --- Proposal fixtures (never committed to git — only the .canon/
    // proposed-learnings/ review surface these tests observe on disk). -----

    // Scenario 1: creation reconciles.
    await writeProposal(
      projectDir,
      tsRecent,
      "sug_LIVE_CREATE1-fixture.md",
      actionableProposal("sug_LIVE_CREATE1", "new-convention", "target/creation-reconciles.md"),
    );

    // Scenario 2: created-then-churned (adversarial, load-bearing).
    await writeProposal(
      projectDir,
      tsRecent,
      "sug_LIVE_CHURN1-fixture.md",
      actionableProposal("sug_LIVE_CHURN1", "new-convention", "target/created-then-churned.md"),
    );

    // Scenario 3: pure-modify unrelated -> NOT reconciled.
    await writeProposal(
      projectDir,
      tsRecent,
      "sug_LIVE_MODIFY1-fixture.md",
      actionableProposal("sug_LIVE_MODIFY1", "severity-change", "target/pure-modify.md"),
    );

    // Scenario 4: informational never reconciled.
    await writeProposal(
      projectDir,
      tsRecent,
      "watch_LIVE_INFO1-fixture.md",
      informationalProposal("watch_LIVE_INFO1"),
    );

    // Scenario 5: stale fully-informational set archives.
    await writeProposal(
      projectDir,
      tsStale,
      "watch_LIVE_STALE1-fixture.md",
      informationalProposal("watch_LIVE_STALE1"),
    );
    await writeProposal(
      projectDir,
      tsStale,
      "watch_LIVE_STALE2-fixture.md",
      informationalProposal("watch_LIVE_STALE2"),
    );

    // Scenario 6: path-escape stays pending.
    await writeProposal(
      projectDir,
      tsRecent,
      "sug_LIVE_ESCAPE1-fixture.md",
      actionableProposal(
        "sug_LIVE_ESCAPE1",
        "new-convention",
        "../../../../../../../../etc/passwd",
      ),
    );

    // Scenario 8: loose top-level file untouched.
    await fs.mkdir(proposedRoot(), { recursive: true });
    await fs.writeFile(
      join(proposedRoot(), "watch_LIVE_LOOSE1-fixture.md"),
      informationalProposal("watch_LIVE_LOOSE1"),
      "utf-8",
    );
  });

  afterAll(async () => {
    await fs.rm(projectDir, { force: true, recursive: true });
  });

  let firstReconciledFiles: string[];
  let firstArchivedFiles: string[];

  it("first run: reconciles the creation and created-then-churned proposals", async () => {
    const result = await reconcileLearnings({ project_dir: projectDir });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok result, got error: ${result.error}`);

    firstReconciledFiles = result.reconciled.map((r) => r.file);
    firstArchivedFiles = result.archived.map((a) => a.file);

    expect(firstReconciledFiles).toContain("sug_LIVE_CREATE1-fixture.md");
    expect(firstReconciledFiles).toContain("sug_LIVE_CHURN1-fixture.md");

    // Real filesystem confirmation — moved via rename into applied/.
    expect(await fileExists(join(recentDir(), "applied", "sug_LIVE_CREATE1-fixture.md"))).toBe(
      true,
    );
    expect(await fileExists(join(recentDir(), "sug_LIVE_CREATE1-fixture.md"))).toBe(false);
    expect(await fileExists(join(recentDir(), "applied", "sug_LIVE_CHURN1-fixture.md"))).toBe(true);
    expect(await fileExists(join(recentDir(), "sug_LIVE_CHURN1-fixture.md"))).toBe(false);

    // Real learning.jsonl append.
    const jsonl = await fs.readFile(learningJsonlPath(), "utf-8");
    const lines = jsonl
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const createLine = lines.find((l) => l.proposal_id === "sug_LIVE_CREATE1-fixture.md");
    const churnLine = lines.find((l) => l.proposal_id === "sug_LIVE_CHURN1-fixture.md");
    expect(createLine?.action).toBe("accepted");
    expect(churnLine?.action).toBe("accepted");
  });

  it("first run: pure-modify-unrelated proposal stays pending (not reconciled)", async () => {
    expect(firstReconciledFiles).not.toContain("sug_LIVE_MODIFY1-fixture.md");
    expect(await fileExists(join(recentDir(), "sug_LIVE_MODIFY1-fixture.md"))).toBe(true);
    expect(await fileExists(join(recentDir(), "applied", "sug_LIVE_MODIFY1-fixture.md"))).toBe(
      false,
    );
  });

  it("first run: informational proposal is never reconciled even though its target shipped", async () => {
    expect(firstReconciledFiles).not.toContain("watch_LIVE_INFO1-fixture.md");
    expect(await fileExists(join(recentDir(), "watch_LIVE_INFO1-fixture.md"))).toBe(true);
  });

  it("first run: stale fully-informational set archives every file to stale/", async () => {
    expect(firstArchivedFiles).toContain("watch_LIVE_STALE1-fixture.md");
    expect(firstArchivedFiles).toContain("watch_LIVE_STALE2-fixture.md");

    expect(await fileExists(join(staleDir(), "stale", "watch_LIVE_STALE1-fixture.md"))).toBe(true);
    expect(await fileExists(join(staleDir(), "stale", "watch_LIVE_STALE2-fixture.md"))).toBe(true);
    expect(await fileExists(join(staleDir(), "watch_LIVE_STALE1-fixture.md"))).toBe(false);
    expect(await fileExists(join(staleDir(), "watch_LIVE_STALE2-fixture.md"))).toBe(false);

    const jsonl = await fs.readFile(learningJsonlPath(), "utf-8");
    const lines = jsonl
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const archivedLine = lines.find((l) => l.proposal_id === "watch_LIVE_STALE1-fixture.md");
    expect(archivedLine?.action).toBe("archived");
  });

  it("first run: a path-escaping target_path stays pending and the file is untouched", async () => {
    expect(firstReconciledFiles).not.toContain("sug_LIVE_ESCAPE1-fixture.md");
    expect(await fileExists(join(recentDir(), "sug_LIVE_ESCAPE1-fixture.md"))).toBe(true);
    // /etc/passwd was never created or touched by this test.
  });

  it("first run: a loose top-level proposal file is never enumerated or moved", async () => {
    const loosePath = join(proposedRoot(), "watch_LIVE_LOOSE1-fixture.md");
    expect(await fileExists(loosePath)).toBe(true);
    const content = await fs.readFile(loosePath, "utf-8");
    expect(content).toContain("watch_LIVE_LOOSE1");
  });

  it("second run over post-run state is a zero-mutation no-op (idempotent)", async () => {
    const jsonlBefore = await fs.readFile(learningJsonlPath(), "utf-8");

    const second = await reconcileLearnings({ project_dir: projectDir });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(`expected ok result, got error: ${second.error}`);

    expect(second.reconciled).toHaveLength(0);
    expect(second.archived).toHaveLength(0);

    const jsonlAfter = await fs.readFile(learningJsonlPath(), "utf-8");
    expect(jsonlAfter).toBe(jsonlBefore);
  });
});
