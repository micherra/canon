/**
 * Graph Worker — child process entry point for background KG pipeline jobs.
 *
 * Receives a WorkerInput message via IPC from the parent process, runs
 * runPipeline, and sends JobMessage updates back. All communication is
 * through process.send() / process.on('message').
 *
 * Entry point only — no direct exports. Import job-adapter.ts for IPC types.
 */

import { runPipeline } from "../../graph/kg-pipeline.ts";
import type { JobMessage, WorkerInput } from "../adapters/job-adapter.ts";

function send(msg: JobMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

process.on("message", async (msg: unknown) => {
  // Comment #5: Validate IPC input shape before casting to WorkerInput.
  // Reject anything that isn't a non-null object with the required string fields.
  if (
    typeof msg !== "object" ||
    msg === null ||
    (msg as Record<string, unknown>).type !== "start" ||
    typeof (msg as Record<string, unknown>).projectDir !== "string" ||
    typeof (msg as Record<string, unknown>).dbPath !== "string"
  ) {
    send({
      message:
        "Invalid WorkerInput: expected { type: 'start', projectDir: string, dbPath: string }",
      type: "error",
    });
    setTimeout(() => process.exit(1), 100);
    return;
  }

  const input = msg as WorkerInput;

  try {
    const result = await runPipeline(input.projectDir, {
      dbPath: input.dbPath,
      onProgress: (phase: string, current: number, total: number) => {
        send({ current, phase, total, type: "progress" });
      },
      sourceDirs: input.sourceDirs,
    });
    send({ result: result as unknown as Record<string, unknown>, type: "complete" });
  } catch (err) {
    // Comment #6: Set exitCode = 1 in catch so finally's process.exit() uses it.
    process.exitCode = 1;
    const error = err as Error;
    send({ message: error.message, stack: error.stack, type: "error" });
  } finally {
    // Allow IPC messages to flush before exiting.
    // process.exit() with no argument uses process.exitCode (1 on error, 0 on success).
    setTimeout(() => process.exit(), 100);
  }
});

export default {};
