/** Canon Orchestration Status — aggregates events into pipeline + ralph loop view */

import { EventStore } from "../drift/event-store.js";
import { RalphStore } from "../drift/ralph-store.js";
import type { OrchestrationEvent } from "../schema.js";

const PIPELINE_PHASES = [
  "research",
  "architect",
  "plan",
  "implement",
  "test",
  "security",
  "review",
] as const;

type PhaseStatus = "pending" | "running" | "completed" | "blocked";

interface AgentInfo {
  name: string;
  status: PhaseStatus;
}

interface PipelineStage {
  phase: string;
  status: PhaseStatus;
  agents: AgentInfo[];
}

interface RalphLoopView {
  current_iteration: number;
  max_iterations: number;
  history: Array<{
    iteration: number;
    verdict: string;
    violations_count: number;
    violations_fixed: number;
  }>;
}

export interface OrchestrationDataOutput {
  pipeline: PipelineStage[];
  ralph_loop?: RalphLoopView;
  events: OrchestrationEvent[];
}

export interface GetOrchestrationDataInput {
  task_slug?: string;
}

export async function getOrchestrationData(
  input: GetOrchestrationDataInput,
  projectDir: string,
): Promise<OrchestrationDataOutput> {
  const eventStore = new EventStore(projectDir);
  const ralphStore = new RalphStore(projectDir);

  const events = await eventStore.getEvents(
    input.task_slug ? { task_slug: input.task_slug } : undefined,
  );

  // Build pipeline from events
  const pipeline: PipelineStage[] = PIPELINE_PHASES.map((phase) => {
    const phaseEvents = events.filter((e) => e.phase === phase);
    const agents: AgentInfo[] = [];
    const agentMap = new Map<string, PhaseStatus>();

    for (const e of phaseEvents) {
      if (e.agent_name) {
        if (e.event_type === "agent_complete") {
          agentMap.set(e.agent_name, "completed");
        } else if (e.event_type === "agent_blocked") {
          agentMap.set(e.agent_name, "blocked");
        } else if (e.event_type === "agent_spawn") {
          if (!agentMap.has(e.agent_name)) {
            agentMap.set(e.agent_name, "running");
          }
        }
      }
    }

    for (const [name, status] of agentMap) {
      agents.push({ name, status });
    }

    let status: PhaseStatus = "pending";
    const hasEnd = phaseEvents.some((e) => e.event_type === "phase_end");
    const hasStart = phaseEvents.some((e) => e.event_type === "phase_start");
    const hasBlocked = agents.some((a) => a.status === "blocked");

    if (hasBlocked) {
      status = "blocked";
    } else if (hasEnd) {
      status = "completed";
    } else if (hasStart) {
      status = "running";
    }

    return { phase, status, agents };
  });

  // Build ralph loop view from most recent loop entry
  let ralph_loop: RalphLoopView | undefined;
  const loops = await ralphStore.getLoops();
  if (loops.length > 0) {
    const latest = loops[loops.length - 1];
    ralph_loop = {
      current_iteration: latest.iterations.length,
      max_iterations: latest.iterations.length,
      history: latest.iterations.map((iter) => ({
        iteration: iter.iteration,
        verdict: iter.verdict,
        violations_count: iter.violations_count,
        violations_fixed: iter.violations_fixed,
      })),
    };
  }

  return {
    pipeline,
    ralph_loop,
    events: events.slice(-50),
  };
}
