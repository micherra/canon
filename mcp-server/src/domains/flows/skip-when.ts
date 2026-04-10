import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getProjectDir } from "@domains/workspaces/wave-lifecycle.ts";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { loadLearnGateConfig } from "@shared/lib/config.ts";
import { acquireLearnLock, getLastLearnTimestamp } from "@shared/lib/learn-lock.ts";
import type { ProcessResult } from "@shared/lib/tool-result.ts";
import type { Board } from "./board-state-schemas.ts";

type SkipResult = {
  skip: boolean;
  reason?: string;
};

/**
 * Dependency injection bag for evaluateSkipWhen.
 * All fields are optional — omitting them uses the concrete infrastructure adapters.
 * Inject mocks in tests to avoid real git/DB calls.
 */
export type SkipWhenDeps = {
  /** Run a git command and return the result. Defaults to gitExec from git-adapter. */
  gitDiff?: (args: string[], cwd: string) => ProcessResult;
  /** Count flow runs since an ISO timestamp. Defaults to getDriftDb().countFlowRunsSince. */
  countFlowRunsSince?: (sinceIso: string) => number;
};

const CONTRACT_PATTERNS = [
  "**/index.ts",
  "**/api/**",
  "**/routes/**",
  "**/types/**",
  "**/schema*",
  "**/public/**",
  "package.json",
  "**/migrations/**",
  // Structure patterns — trigger context-sync for README-relevant changes
  "README.md",
  "**/README.md",
  "Dockerfile",
  "**/Dockerfile",
  "docker-compose*",
  "Makefile",
  "**/bin/**",
];

export async function evaluateSkipWhen(
  condition: string,
  _workspace: string,
  board: Board,
  deps?: SkipWhenDeps,
): Promise<SkipResult> {
  switch (condition) {
    case "no_contract_changes":
      return evaluateNoContractChanges(board.base_commit, deps);
    case "no_fix_requested":
      return evaluateNoFixRequested(board);
    case "auto_approved":
      return evaluateAutoApproved(board);
    case "no_open_questions":
      return evaluateNoOpenQuestions(board);
    case "learn_gate_not_passed":
      return evaluateLearnGateNotPassed(_workspace, deps);
    default:
      console.error(`Warning: Unknown skip_when condition "${condition}" — not skipping`);
      return { skip: false };
  }
}

const BASE_COMMIT_RE = /^[a-f0-9]{7,40}$/;

function evaluateNoContractChanges(baseCommit: string, deps?: SkipWhenDeps): SkipResult {
  if (!BASE_COMMIT_RE.test(baseCommit)) {
    // Reject malicious or malformed commit refs — safe default: do not skip
    return { skip: false };
  }

  const runGitDiff = deps?.gitDiff ?? gitExec;

  try {
    const result = runGitDiff(
      ["diff", "--diff-filter=d", "--name-only", `${baseCommit}..HEAD`],
      process.cwd(),
    );
    if (!result.ok) return { skip: false };
    const output = result.stdout;
    const changedFiles = output.trim().split("\n").filter(Boolean);

    const hasContractChange = changedFiles.some((file) =>
      CONTRACT_PATTERNS.some((pattern) => matchGlob(pattern, file)),
    );

    if (!hasContractChange) {
      return {
        reason: "No contract changes detected — all changes are internal",
        skip: true,
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
    reason: "No fix requested — user has not flagged issues for fixing",
    skip: true,
  };
}

function evaluateAutoApproved(board: Board): SkipResult {
  if (board.metadata?.auto_approve === true) {
    return {
      reason: "Task auto-approved — checkpoint skipped",
      skip: true,
    };
  }
  return { skip: false };
}

function evaluateNoOpenQuestions(board: Board): SkipResult {
  if (board.metadata?.has_open_questions === true) {
    return { skip: false };
  }
  return {
    reason: "No open questions from pattern-check — targeted research skipped",
    skip: true,
  };
}

/** 10-minute scan throttle — prevents repeated flow-count DB queries. */
const SCAN_THROTTLE_MS = 10 * 60 * 1000;

/**
 * ADR-016: Evaluate all learn gates in cheapest-first order.
 * Returns skip: false only when all 5 gates pass.
 * Fail-open: any error → skip: true (learner never blocks flow completion).
 *
 * Uses the same shared helpers as learn-gate.ts (config, lock) to avoid
 * importing from @features/orchestration/ — which would cross the DDD boundary.
 */
/** Check scan throttle gate. Returns a skip reason or null to continue. */
async function checkScanThrottle(throttlePath: string): Promise<string | null> {
  try {
    const throttleStat = await stat(throttlePath);
    const msSinceThrottle = Date.now() - throttleStat.mtime.getTime();
    if (msSinceThrottle < SCAN_THROTTLE_MS) return "scan throttle: checked recently";
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "scan throttle: stat error";
  }
  return null;
}

async function evaluateLearnGateNotPassed(
  workspace: string,
  deps?: SkipWhenDeps,
): Promise<SkipResult> {
  try {
    const projectDir = getProjectDir(workspace);
    const canonDir = join(projectDir, ".canon");

    // Gate 1: Config check — auto-learn enabled
    const config = await loadLearnGateConfig(projectDir);
    if (!config.enabled) {
      return { reason: "auto-learn disabled", skip: true };
    }

    // Gate 2: Time gate — hours since last learn
    const lastLearnTs = await getLastLearnTimestamp(canonDir);
    if (lastLearnTs !== null) {
      const hoursSinceLast = (Date.now() - lastLearnTs) / (1000 * 60 * 60);
      if (hoursSinceLast < config.min_hours_since_last) {
        return {
          reason: `time gate: ${hoursSinceLast.toFixed(1)}h < ${config.min_hours_since_last}h`,
          skip: true,
        };
      }
    }

    // Gate 3: Scan throttle — prevent repeated flow-count queries
    const throttlePath = join(canonDir, "learn-throttle");
    const throttleReason = await checkScanThrottle(throttlePath);
    if (throttleReason) return { reason: throttleReason, skip: true };

    // Gate 4: Flow gate — enough flows since last learn
    const sinceIso =
      lastLearnTs !== null ? new Date(lastLearnTs).toISOString() : "1970-01-01T00:00:00.000Z";
    const flowCount = deps?.countFlowRunsSince
      ? deps.countFlowRunsSince(sinceIso)
      : getDriftDb(projectDir).countFlowRunsSince(sinceIso);
    if (flowCount < config.min_flows_since_last) {
      try {
        await writeFile(throttlePath, "", { flag: "w", mode: 0o600 });
      } catch {
        /* best effort */
      }
      return {
        reason: `flow gate: ${flowCount} < ${config.min_flows_since_last}`,
        skip: true,
      };
    }

    // Gate 5: Lock gate — acquire the learn lock
    const staleAfterMs = config.lock_stale_after_hours * 60 * 60 * 1000;
    const lockResult = await acquireLearnLock(canonDir, staleAfterMs);
    if (!lockResult.acquired) {
      return { reason: `lock gate: ${lockResult.reason}`, skip: true };
    }

    // All gates passed — do NOT skip (learner will run)
    return { skip: false };
  } catch {
    // Fail-open: any error means skip the learner (never block flow completion)
    return { reason: "Learn gate evaluation failed — skipping learner", skip: true };
  }
}

/** Simple glob matching for contract patterns. */
export function matchGlob(pattern: string, filePath: string): boolean {
  const regex = pattern
    .replace(/\*\*/g, "<<<DSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DSTAR>>>/g, ".*");
  return new RegExp(`^${regex}$`).test(filePath) || new RegExp(`(^|/)${regex}$`).test(filePath);
}
