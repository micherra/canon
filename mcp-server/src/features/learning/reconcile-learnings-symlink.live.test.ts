/**
 * Symlink-escape regression tests for `reconcileLearnings`'s containment
 * (fresh adversarial review, round 2 — see `REVIEW-adversarial.meta.json`
 * V1 — and round 3, see `REVIEW-adversarial-2.meta.json`'s single BLOCKING
 * finding).
 *
 * Round 2 fixed: the prior fix round threaded `resolveScope(extra)` into
 * both `appendLearningRecord` and `reconcileLearnings`, but gave them
 * different containment primitives: `appendLearningRecord` uses
 * `isPathInWorktree` (resolves symlinks via `realpath`), while
 * `reconcileLearnings` used the pure `isPathContained` (a string-only
 * `relative()` comparison — never dereferences a symlink). An in-scope
 * symlink pointing OUTSIDE scope passes `isSafeProjectDirInput` (absolute,
 * no `..` segments) AND passes `isPathContained`
 * (`relative('/scope', '/scope/evil-link')` === `'evil-link'`, which starts
 * with neither `..` nor `/`), so the old guard treated it as contained.
 *
 * Round 3 fixes the SAME class one directory level deeper: round 2 contained
 * `input.project_dir` itself, but both handlers then `join(project_dir,
 * ".canon", ...)` WITHOUT re-validating that joined subpath. A genuine,
 * in-scope `project_dir` (passes the round-2 guard) whose OWN
 * `project_dir/.canon` is a symlink pointing out of scope reproduces the
 * exact same impact — out-of-scope rename + out-of-scope `learning.jsonl`
 * append — one level down. The second test below is that exact PoC.
 *
 * This suite drives the REAL `reconcileLearnings` with no seams argument
 * (falls back to `defaultFsSeam`, real `node:fs/promises`) against genuine
 * `mkdtemp` temp directories and a genuine `fs.symlink` — never fakes. A
 * fake-seam test cannot catch this class: this file's in-memory
 * `ReconcileFsSeam` fakes have no real filesystem to dereference a symlink
 * against in the first place.
 */

import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { reconcileLearnings } from "./reconcile-learnings.ts";

function informationalProposal(id: string): string {
  return ["---", `id: ${id}`, "type: watch", "---", "", "## Watch"].join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

describe("reconcileLearnings — symlink escape (live, real fs, no seams)", () => {
  let scopeDir: string;
  let victimDir: string;
  let evilLink: string;
  const STALE_TS_DIR = "2020-01-01T00-00-00Z"; // decades old — always past FRESHNESS_DAYS

  afterAll(async () => {
    await fs.rm(scopeDir, { force: true, recursive: true });
    await fs.rm(victimDir, { force: true, recursive: true });
  });

  it("rejects a project_dir symlink that resolves outside the resolved scope, with zero mutations to the victim", async () => {
    scopeDir = await fs.mkdtemp(join(tmpdir(), "reconcile-symlink-scope-"));
    victimDir = await fs.mkdtemp(join(tmpdir(), "reconcile-symlink-victim-"));

    // Victim is a genuinely out-of-scope directory with its own stale,
    // fully-informational proposal set — exactly the shape the adversarial
    // review's PoC used to get `reconcileLearnings` to rename a file and
    // append to `learning.jsonl` OUTSIDE the caller's resolved scope.
    const victimTsDirPath = join(victimDir, ".canon", "proposed-learnings", STALE_TS_DIR);
    await fs.mkdir(victimTsDirPath, { recursive: true });
    const victimProposalPath = join(victimTsDirPath, "watch_VICTIM1-fixture.md");
    await fs.writeFile(victimProposalPath, informationalProposal("watch_VICTIM1"), "utf-8");

    // The attacker plants a symlink INSIDE the resolved scope that points
    // OUTSIDE it — `evil-link` passes both `isSafeProjectDirInput` (it's an
    // absolute path with no `..` segments) and the old pure `isPathContained`
    // check (it's logically "inside" scopeDir by string comparison).
    evilLink = join(scopeDir, "evil-link");
    await fs.symlink(victimDir, evilLink);

    const result = await reconcileLearnings({ project_dir: evilLink }, scopeDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the symlink escape to be rejected");
    expect(result.error_code).toBe("INVALID_INPUT");

    // The victim's proposal must NOT have been moved into stale/.
    expect(await fileExists(victimProposalPath)).toBe(true);
    expect(await fileExists(join(victimTsDirPath, "stale", "watch_VICTIM1-fixture.md"))).toBe(
      false,
    );

    // No learning.jsonl must have been created/appended outside scope.
    expect(await fileExists(join(victimDir, ".canon", "learning.jsonl"))).toBe(false);
  });

  it("rejects a project_dir/.canon symlink that resolves outside the resolved scope, with a genuine in-scope project_dir (round-3 PoC)", async () => {
    // project_dir itself is real, in-scope, and passes the round-2 guard —
    // the escape moved to project_dir/.canon, one level deeper.
    const scopeAndProjectDir = await fs.mkdtemp(join(tmpdir(), "reconcile-symlink-scope2-"));
    const victim2Dir = await fs.mkdtemp(join(tmpdir(), "reconcile-symlink-victim2-"));

    const victimTsDirPath = join(victim2Dir, ".canon", "proposed-learnings", STALE_TS_DIR);
    await fs.mkdir(victimTsDirPath, { recursive: true });
    const victimProposalPath = join(victimTsDirPath, "watch_VICTIM2-fixture.md");
    await fs.writeFile(victimProposalPath, informationalProposal("watch_VICTIM2"), "utf-8");

    // The attacker plants project_dir/.canon as a symlink to victim2Dir's
    // .canon — everything reconcile touches (proposed-learnings scan,
    // learning.jsonl append) lives under this one joined subpath.
    const evilCanonLink = join(scopeAndProjectDir, ".canon");
    await fs.symlink(join(victim2Dir, ".canon"), evilCanonLink);

    try {
      const result = await reconcileLearnings(
        { project_dir: scopeAndProjectDir },
        scopeAndProjectDir,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected the .canon symlink escape to be rejected");
      expect(result.error_code).toBe("INVALID_INPUT");

      // The victim's proposal must NOT have been moved into stale/.
      expect(await fileExists(victimProposalPath)).toBe(true);
      expect(await fileExists(join(victimTsDirPath, "stale", "watch_VICTIM2-fixture.md"))).toBe(
        false,
      );

      // No learning.jsonl must have been created/appended outside scope.
      expect(await fileExists(join(victim2Dir, ".canon", "learning.jsonl"))).toBe(false);
    } finally {
      await fs.rm(scopeAndProjectDir, { force: true, recursive: true });
      await fs.rm(victim2Dir, { force: true, recursive: true });
    }
  });
});
