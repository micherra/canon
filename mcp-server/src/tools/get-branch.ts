/** Returns the current git branch name. */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface GetBranchOutput {
  branch: string;
}

export async function getBranch(projectDir: string): Promise<GetBranchOutput> {
  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectDir,
      timeout: 5000,
    });
    return { branch: stdout.trim() };
  } catch {
    return { branch: "unknown" };
  }
}
