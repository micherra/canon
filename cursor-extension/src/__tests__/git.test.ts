import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { getCurrentBranch, getChangedFiles } from "../services/git";

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "test@test.com");
  await git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "init.txt"), "init");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "init");
}

describe("getCurrentBranch", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-git-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns branch name in a git repo", async () => {
    await initRepo(tmpDir);

    const branch = await getCurrentBranch(tmpDir);

    expect(branch).toBe("main");
  });

  it("returns null for non-git directory", async () => {
    const branch = await getCurrentBranch(tmpDir);

    expect(branch).toBeNull();
  });
});

describe("getChangedFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-git-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for non-git directory", async () => {
    const files = await getChangedFiles(tmpDir);

    expect(files).toEqual([]);
  });

  it("returns empty array on main with no changes", async () => {
    await initRepo(tmpDir);

    const files = await getChangedFiles(tmpDir);

    expect(files).toEqual([]);
  });

  it("returns changed files on a feature branch", async () => {
    await initRepo(tmpDir);
    await git(tmpDir, "checkout", "-b", "feature");
    await writeFile(join(tmpDir, "new-file.ts"), "export const x = 1;");
    await git(tmpDir, "add", ".");
    await git(tmpDir, "commit", "-m", "add new file");

    const files = await getChangedFiles(tmpDir);

    expect(files).toContain("new-file.ts");
  });

  it("includes uncommitted changes", async () => {
    await initRepo(tmpDir);
    await git(tmpDir, "checkout", "-b", "feature");
    await writeFile(join(tmpDir, "init.txt"), "modified");

    const files = await getChangedFiles(tmpDir);

    expect(files).toContain("init.txt");
  });

  it("deduplicates committed and uncommitted changes to the same file", async () => {
    await initRepo(tmpDir);
    await git(tmpDir, "checkout", "-b", "feature");
    // Commit a change
    await writeFile(join(tmpDir, "init.txt"), "committed change");
    await git(tmpDir, "add", ".");
    await git(tmpDir, "commit", "-m", "modify init");
    // Make another uncommitted change to the same file
    await writeFile(join(tmpDir, "init.txt"), "uncommitted change");

    const files = await getChangedFiles(tmpDir);

    const initCount = files.filter((f) => f === "init.txt").length;
    expect(initCount).toBe(1);
  });
});
