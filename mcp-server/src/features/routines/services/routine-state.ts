import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CANON_DIR } from "@shared/constants.ts";
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persisted run-state for a single routine.
 * Stored at `.canon/routines-state/<name>.json` under the project directory.
 *
 * `markers` provides cloud run-to-run memory: arbitrary key/value pairs a
 * cloud routine can write and read across invocations. Values are restricted
 * to scalar primitives so the state file stays JSON-safe and diff-friendly.
 */
export type RoutineState = {
  /** ISO-8601 timestamp of the last run, if any. */
  last_run?: string;
  /** Outcome string from the last run (e.g., "success", "failure"). */
  last_outcome?: string;
  /** Free-form marker map for cloud run-to-run memory. */
  markers?: Record<string, string | number | boolean>;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROUTINES_STATE_DIR = "routines-state";

function stateFilePath(projectDir: string, name: string): string {
  return join(projectDir, CANON_DIR, ROUTINES_STATE_DIR, `${name}.json`);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read the persisted run-state for a routine.
 *
 * Fail-open: returns `null` when the file does not exist (ENOENT).
 * Never throws for expected error conditions (errors-are-values).
 */
export async function readRoutineState(
  projectDir: string,
  name: string,
): Promise<RoutineState | null> {
  const filePath = stateFilePath(projectDir, name);
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as RoutineState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    // For parse errors or other unexpected errors, also fail-open
    console.warn(
      "[canon] routine-state: failed to read state for",
      name,
      ":",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write the run-state for a routine.
 *
 * Creates the `.canon/routines-state/` directory if it does not exist.
 * Uses atomicWriteFile to prevent partial reads on concurrent access.
 */
export async function writeRoutineState(
  projectDir: string,
  name: string,
  state: RoutineState,
): Promise<void> {
  const filePath = stateFilePath(projectDir, name);
  await mkdir(dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, JSON.stringify(state, null, 2));
}
