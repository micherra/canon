import { RalphStore } from "../drift/ralph-store.js";
import { generateId } from "../utils/id.js";
import type { RalphLoopEntry, RalphIterationResult } from "../schema.js";

export interface LogRalphInput {
  task_slug: string;
  iterations: RalphIterationResult[];
  final_verdict: "BLOCKING" | "WARNING" | "CLEAN";
  converged: boolean;
  team: string[];
}

export interface LogRalphOutput {
  recorded: boolean;
  id: string;
  note: string;
}

export async function logRalph(
  input: LogRalphInput,
  projectDir: string
): Promise<LogRalphOutput> {
  const store = new RalphStore(projectDir);
  const id = generateId("ralph");

  const entry: RalphLoopEntry = {
    loop_id: id,
    task_slug: input.task_slug,
    timestamp: new Date().toISOString(),
    iterations: input.iterations,
    final_verdict: input.final_verdict,
    converged: input.converged,
    team: input.team,
  };

  await store.appendLoop(entry);

  const iterCount = input.iterations.length;
  const convergenceNote = input.converged
    ? `Converged to ${input.final_verdict} in ${iterCount} iteration(s).`
    : `Stopped after ${iterCount} iteration(s) with ${input.final_verdict} verdict.`;

  return {
    recorded: true,
    id,
    note: `Ralph loop logged. ${convergenceNote}`,
  };
}

