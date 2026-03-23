import { spawnSync } from "node:child_process";
import type { Board } from "./flow-schema.js";

interface SkipResult {
  skip: boolean;
  reason?: string;
}

const CONTRACT_PATTERNS = [
  "**/index.ts",
  "**/api/**",
  "**/routes/**",
  "**/types/**",
  "**/schema*",
  "**/public/**",
  "package.json",
  "**/migrations/**",
];

export async function evaluateSkipWhen(
  condition: string,
  workspace: string,
  board: Board,
): Promise<SkipResult> {
  switch (condition) {
    case "no_contract_changes":
      return evaluateNoContractChanges(board.base_commit);
    case "no_fix_requested":
      return evaluateNoFixRequested(board);
    default:
      console.error(
        `Warning: Unknown skip_when condition "${condition}" — not skipping`,
      );
      return { skip: false };
  }
}

const BASE_COMMIT_RE = /^[a-f0-9]{7,40}$/;

function evaluateNoContractChanges(baseCommit: string): SkipResult {
  if (!BASE_COMMIT_RE.test(baseCommit)) {
    // Reject malicious or malformed commit refs — safe default: do not skip
    return { skip: false };
  }

  try {
    const result = spawnSync("git", ["diff", "--name-only", `${baseCommit}..HEAD`], {
      encoding: "utf-8",
    });

    if (result.error || result.status !== 0) {
      return { skip: false };
    }

    const output: string = result.stdout ?? "";
    const changedFiles = output.trim().split("\n").filter(Boolean);

    const hasContractChange = changedFiles.some((file) =>
      CONTRACT_PATTERNS.some((pattern) => matchGlob(pattern, file)),
    );

    if (!hasContractChange) {
      return {
        skip: true,
        reason: "No contract changes detected — all changes are internal",
      };
    }
    return { skip: false };
  } catch {
    // If git diff fails, do not skip (fail-open for skip, fail-closed for execution)
    return { skip: false };
  }
}

function evaluateNoFixRequested(board: Board): SkipResult {
  if (board.metadata?.fix_requested === true) {
    return { skip: false };
  }
  return {
    skip: true,
    reason: "No fix requested — user has not flagged issues for fixing",
  };
}

/** Simple glob matching for contract patterns. */
export function matchGlob(pattern: string, filePath: string): boolean {
  const regex = pattern
    .replace(/\*\*/g, "<<<DSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DSTAR>>>/g, ".*");
  return (
    new RegExp(`^${regex}$`).test(filePath) ||
    new RegExp(`(^|/)${regex}$`).test(filePath)
  );
}
