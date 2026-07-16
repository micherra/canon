/**
 * Injectable fs/git seams for `reconcile_learnings` (`reconcile-learnings.ts`,
 * ADR-0050) — split out into its own module to keep the handler file under
 * the line-count lint budget (the same reason `reconcile-learnings.test.ts`
 * was split into `reconcile-learnings-fixes.test.ts`).
 *
 * Tests supply fully in-memory fakes for `ReconcileFsSeam`/`ReconcileGitSeam`;
 * production wiring uses `defaultFsSeam`/`defaultGitSeam` below, both real
 * `node:fs/promises` / `gitExec` implementations.
 */

import fs from "node:fs/promises";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { isNotFound } from "@shared/lib/errors.ts";
import { appendRawLineHealing } from "@shared/lib/jsonl-append.ts";

export type DirEntry = { name: string; isDirectory: boolean };

/** Filesystem operations reconcile needs, as an injectable seam. */
export type ReconcileFsSeam = {
  /** Lists directory entries; returns [] when the directory does not exist. */
  readDir(path: string): Promise<DirEntry[]>;
  /** Reads a file as utf-8 text; throws when the file does not exist. */
  readFile(path: string): Promise<string>;
  /** Returns true when a path exists on disk. */
  fileExists(path: string): Promise<boolean>;
  /** Recursively creates a directory; no-op if it already exists. */
  mkdir(path: string): Promise<void>;
  /** Moves a file — the ONLY relocation primitive reconcile uses (never a delete). */
  rename(from: string, to: string): Promise<void>;
  /** Appends text to a file, creating it if absent. Never rewrites existing content. */
  appendFile(path: string, data: string): Promise<void>;
  realpath(path: string): Promise<string>; // resolves symlinks; test fakes supply an identity resolver
};

/**
 * Evidence about the most recent commit satisfying the post-proposal-commit
 * predicate for a target path.
 */
export type CommitEvidence = {
  /** Short commit hash. */
  hash: string;
  /**
   * True when THIS commit's diff created `targetPath` (a genuine new-file
   * addition). File creation is sufficient evidence on its own — the
   * relevance check below only applies when this is false (the target
   * already existed and the commit only modified it).
   */
  createdFile: boolean;
  /** Commit subject + body — used for the content-linkage relevance check. */
  message: string;
};

/** Git operations reconcile needs, as an injectable seam. */
export type ReconcileGitSeam = {
  /**
   * Returns evidence for the most recent commit touching `targetPath` at or
   * after `sinceIso`, or null when no such commit exists. This is the base
   * evidence predicate: a proposal only reconciles when its target both
   * exists on disk AND has a commit that post-dates the proposal. Whether
   * that evidence is SUFFICIENT (creation vs. relevance-checked modification)
   * is decided by the caller — see `evaluateActionableProposal`.
   *
   * NOTE: this returns only the SINGLE most recent qualifying commit. A
   * target created by an older commit and later churned by an unrelated,
   * newer commit is reported here as the newer (non-creating) commit — see
   * `creationCommitSince` for the dedicated probe that recovers the older
   * creation evidence regardless of later churn.
   */
  latestCommitSince(
    projectDir: string,
    targetPath: string,
    sinceIso: string,
  ): CommitEvidence | null;
  /**
   * Dedicated creation probe: returns evidence for the most recent commit
   * that ADDED `targetPath` at or after `sinceIso`, or null when no such
   * creating commit exists in that window. Independent of
   * `latestCommitSince` — a target can have an older creating commit AND a
   * newer, unrelated modifying commit; `latestCommitSince` alone would only
   * ever see the newer one. Creation is sufficient evidence on its own
   * (decision 0047), so the caller checks this FIRST, before falling back to
   * `latestCommitSince`'s modify-plus-relevance path.
   */
  creationCommitSince(
    projectDir: string,
    targetPath: string,
    sinceIso: string,
  ): CommitEvidence | null;
};

async function readDirDefault(path: string): Promise<DirEntry[]> {
  try {
    const entries = await fs.readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ isDirectory: e.isDirectory(), name: e.name }));
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

async function fileExistsDefault(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default fs seam — real filesystem via node:fs/promises.
 *
 * `appendFile` routes through `appendRawLineHealing` (`@shared/lib/jsonl-append.ts`)
 * instead of a bare `fs.appendFile` — this is the fix for the merged-line
 * defect (PROBE-FINDINGS.md P1): an append landing on a predecessor that
 * left its line open now heals it with a `\n` prefix instead of merging
 * onto it. The `ReconcileFsSeam.appendFile(path, data)` signature is
 * unchanged (`data` is already the fully-formatted, newline-terminated
 * line `moveAndAppend` builds via `jsonlLine`) — only this real
 * implementation's body changed; the fake seams in
 * reconcile-learnings.test.ts / reconcile-learnings-fixes.test.ts are
 * untouched and continue to exercise the plan/apply logic in isolation.
 */
export const defaultFsSeam: ReconcileFsSeam = {
  appendFile: async (path, data) => {
    const { healed } = await appendRawLineHealing(path, data);
    if (healed)
      console.warn(`[reconcile-learnings] healed a bypassed append at ${path} (ADR-0056)`);
  },
  fileExists: fileExistsDefault,
  mkdir: (path) => fs.mkdir(path, { recursive: true }).then(() => undefined),
  readDir: readDirDefault,
  readFile: (path) => fs.readFile(path, "utf-8"),
  realpath: (path) => fs.realpath(path),
  rename: (from, to) => fs.rename(from, to),
};

/** Default git seam — real `git log`/`git show` via the shared git adapter. */
export const defaultGitSeam: ReconcileGitSeam = {
  creationCommitSince(projectDir, targetPath, sinceIso) {
    // `--diff-filter=A` restricts git log to commits that ADDED targetPath —
    // this finds the creating commit directly, regardless of how many later
    // commits touched the file since.
    const result = gitExec(
      [
        "log",
        "--since",
        sinceIso,
        "--diff-filter=A",
        "-n",
        "1",
        "--format=%h%x00%B",
        "--",
        targetPath,
      ],
      projectDir,
    );
    if (!result.ok) return null;
    const raw = result.stdout.trim();
    if (raw.length === 0) return null;

    const sep = raw.indexOf("\0");
    const hash = sep === -1 ? raw : raw.slice(0, sep);
    const message = sep === -1 ? "" : raw.slice(sep + 1).trim();

    return { createdFile: true, hash, message };
  },

  latestCommitSince(projectDir, targetPath, sinceIso) {
    const result = gitExec(
      ["log", "--since", sinceIso, "-n", "1", "--format=%h%x00%B", "--", targetPath],
      projectDir,
    );
    if (!result.ok) return null;
    const raw = result.stdout.trim();
    if (raw.length === 0) return null;

    const sep = raw.indexOf("\0");
    const hash = sep === -1 ? raw : raw.slice(0, sep);
    const message = sep === -1 ? "" : raw.slice(sep + 1).trim();

    // Was targetPath ADDED (not just modified) by this specific commit?
    const statusResult = gitExec(
      ["show", "--format=", "--name-status", hash, "--", targetPath],
      projectDir,
    );
    const createdFile = statusResult.ok && /^A\s/m.test(statusResult.stdout.trim());

    return { createdFile, hash, message };
  },
};
