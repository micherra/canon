import { EventEmitter } from "node:events";
import { appendFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HistoryEntry, ConcernEntry, GateResult, PostconditionResult, ViolationSeverities, TestResults } from "./flow-schema.ts";

export type FlowEventType =
  | "state_entered"
  | "state_completed"
  | "agent_spawned"
  | "transition_evaluated"
  | "hitl_triggered"
  | "flow_started"
  | "flow_completed"
  | "board_updated"
  | "wave_event_injected"
  | "wave_event_resolved";

export interface FlowEventMap {
  state_entered: {
    stateId: string;
    stateType: string;
    timestamp: string;
    iterationCount: number;
  };
  state_completed: {
    stateId: string;
    result: string;
    duration_ms: number;
    artifacts: string[];
    timestamp: string;
    gate_results?: GateResult[];
    postcondition_results?: PostconditionResult[];
    violation_count?: number;
    violation_severities?: ViolationSeverities;
    test_results?: TestResults;
    files_changed?: number;
    discovered_gates_count?: number;
    discovered_postconditions_count?: number;
  };
  agent_spawned: {
    stateId: string;
    agent: string;
    role?: string;
    model: string;
    timestamp: string;
  };
  transition_evaluated: {
    stateId: string;
    statusKeyword: string;
    normalizedCondition: string;
    nextState: string;
    timestamp: string;
  };
  hitl_triggered: {
    stateId: string;
    reason: string;
    iterationCount?: number;
    stuckHistory?: HistoryEntry[];
    timestamp: string;
  };
  flow_started: {
    flowName: string;
    task: string;
    tier: string;
    workspace: string;
    timestamp: string;
  };
  flow_completed: {
    flowName: string;
    task: string;
    concerns: ConcernEntry[];
    skipped: string[];
    duration_ms: number;
    totalSpawns: number;
    timestamp: string;
  };
  board_updated: {
    action: string;
    stateId?: string;
    timestamp: string;
  };
  wave_event_injected: {
    eventId: string;
    eventType: string;
    workspace: string;
    timestamp: string;
  };
  wave_event_resolved: {
    eventId: string;
    eventType: string;
    action: "apply" | "reject";
    workspace: string;
    timestamp: string;
  };
}

export class FlowEventBus extends EventEmitter {
  emit<T extends FlowEventType>(type: T, event: FlowEventMap[T]): boolean {
    return super.emit(type, event);
  }

  on<T extends FlowEventType>(
    type: T,
    handler: (event: FlowEventMap[T]) => void,
  ): this {
    return super.on(type, handler);
  }
}

export function createJsonlLogger(
  workspace: string,
): (type: FlowEventType, event: FlowEventMap[FlowEventType]) => Promise<void> {
  const logPath = `${workspace}/log.jsonl`;
  mkdirSync(dirname(logPath), { recursive: true });

  // Chain writes sequentially to preserve ordering
  let pending: Promise<void> = Promise.resolve();

  return (type: FlowEventType, event: FlowEventMap[FlowEventType]) => {
    const line = JSON.stringify({ type, ...event });
    pending = pending
      .then(() => appendFile(logPath, line + "\n"))
      .catch(() => {
        // Best-effort logging — don't crash the flow on write failure
      });
    return pending;
  };
}

export function createMetricsAccumulator(): {
  handler: (type: FlowEventType, event: any) => void;
  getMetrics: () => {
    totalSpawns: number;
    totalDuration: number;
    perState: Record<string, { duration_ms: number; spawns: number }>;
  };
} {
  let totalSpawns = 0;
  let totalDuration = 0;
  const perState: Record<string, { duration_ms: number; spawns: number }> = {};

  function ensureState(stateId: string) {
    if (!perState[stateId]) {
      perState[stateId] = { duration_ms: 0, spawns: 0 };
    }
  }

  const handler = (type: FlowEventType, event: any) => {
    if (type === "agent_spawned") {
      totalSpawns++;
      ensureState(event.stateId);
      perState[event.stateId].spawns++;
    } else if (type === "state_completed") {
      totalDuration += event.duration_ms;
      ensureState(event.stateId);
      perState[event.stateId].duration_ms += event.duration_ms;
    }
  };

  const getMetrics = () => ({
    totalSpawns,
    totalDuration,
    perState,
  });

  return { handler, getMetrics };
}
