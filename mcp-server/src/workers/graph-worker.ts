/**
 * Graph Worker — child process entry point for background KG pipeline jobs.
 *
 * Receives a WorkerInput message via IPC from the parent process, runs
 * runPipeline, and sends JobMessage updates back. All communication is
 * through process.send() / process.on('message').
 *
 * Entry point only — no direct exports. Import job-adapter.ts for IPC types.
 */

import { runPipeline } from "../graph/kg-pipeline.ts";
import type { WorkerInput, JobMessage } from "../adapters/job-adapter.ts";

function send(msg: JobMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

process.on("message", async (msg: unknown) => {
  const input = msg as WorkerInput;
  if (input.type !== "start") return;

  try {
    const result = await runPipeline(input.projectDir, {
      dbPath: input.dbPath,
      sourceDirs: input.sourceDirs,
      onProgress: (phase: string, current: number, total: number) => {
        send({ type: "progress", phase, current, total });
      },
    });
    send({ type: "complete", result: result as unknown as Record<string, unknown> });
  } catch (err) {
    const error = err as Error;
    send({ type: "error", message: error.message, stack: error.stack });
  } finally {
    // Allow IPC messages to flush before exiting
    setTimeout(() => process.exit(0), 100);
  }
});

export default {};
