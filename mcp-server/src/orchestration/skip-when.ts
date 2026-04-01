import { gitExec } from "../adapters/git-adapter.ts";
import type { Board } from "./flow-schema.ts";

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
  _workspace: string,
  board: Board,
): Promise<SkipResult> {
  switch (condition) {
    case "no_contract_changes":
      return evaluateNoContractChanges(board.base_commit);
    case "no_fix_requested":
      return evaluateNoFixRequested(board);
    case "auto_approved":
      return evaluateAutoApproved(board);
    case "no_open_questions":
      return evaluateNoOpenQuestions(board);
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
    const result = gitExec(["diff", "--diff-filter=d", "--name-only", `${baseCommit}..HEAD`], process.cwd());
    if (!result.ok) return { skip: false };
    const output = result.stdout;
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

function evaluateAutoApproved(board: Board): SkipResult {
  if (board.metadata?.auto_approve === true) {
    return {
      skip: true,
      reason: "Task auto-approved — checkpoint skipped",
    };
  }
  return { skip: false };
}

function evaluateNoOpenQuestions(board: Board): SkipResult {
  if (board.metadata?.has_open_questions === true) {
    return { skip: false };
  }
  return {
    skip: true,
    reason: "No open questions from pattern-check — targeted research skipped",
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
