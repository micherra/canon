import { execFile } from "child_process";

/** Get the current git branch name */
export function getCurrentBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout.trim() || null);
    });
  });
}

/** Check if a git ref exists */
function refExists(cwd: string, ref: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--verify", ref], { cwd }, (err) => {
      resolve(!err);
    });
  });
}

/** Get files changed between current branch and main */
export async function getChangedFiles(cwd: string): Promise<string[]> {
  const branch = await getCurrentBranch(cwd);
  if (!branch) return [];

  // Find the base to diff against
  let base: string | null = null;
  if (await refExists(cwd, "origin/main")) base = "origin/main";
  else if (await refExists(cwd, "origin/master")) base = "origin/master";
  else if (await refExists(cwd, "main")) base = "main";
  else if (await refExists(cwd, "master")) base = "master";

  if (!base) return [];

  // Use diff for uncommitted + committed changes vs base
  return new Promise((resolve) => {
    execFile("git", ["diff", "--name-only", base!, "HEAD"], { cwd }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      const committed = stdout.trim().split("\n").filter(Boolean);

      // Also include uncommitted changes (staged + unstaged)
      execFile("git", ["diff", "--name-only", "HEAD"], { cwd }, (err2, stdout2) => {
        if (err2) {
          resolve(committed);
          return;
        }
        const uncommitted = stdout2.trim().split("\n").filter(Boolean);
        const all = new Set([...committed, ...uncommitted]);
        resolve([...all]);
      });
    });
  });
}
