import { EventEmitter } from "node:events";
import { z } from "zod";
import type {
  ConcernEntry,
  GateResult,
  HistoryEntry,
  PostconditionResult,
  TestResults,
  ViolationSeverities,
} from "./flow-schema.ts";

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
  | "wave_event_resolved"
  | "stuck_detected";

export type FlowEventMap = {
  state_entered: {
    stateId: string;
    stateType: string;
    timestamp: string;
    iterationCount: number;
    correlation_id?: string;
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
    correlation_id?: string;
  };
  agent_spawned: {
    stateId: string;
    agent: string;
    role?: string;
    model: string;
    timestamp: string;
    correlation_id?: string;
  };
  transition_evaluated: {
    stateId: string;
    statusKeyword: string;
    normalizedCondition: string;
    nextState: string;
    timestamp: string;
    correlation_id?: string;
  };
  hitl_triggered: {
    stateId: string;
    reason: string;
    iterationCount?: number;
    stuckHistory?: HistoryEntry[];
    timestamp: string;
    correlation_id?: string;
  };
  flow_started: {
    flowName: string;
    task: string;
    tier: string;
    workspace: string;
    timestamp: string;
    correlation_id?: string;
  };
  flow_completed: {
    flowName: string;
    task: string;
    concerns: ConcernEntry[];
    skipped: string[];
    duration_ms: number;
    totalSpawns: number;
    timestamp: string;
    correlation_id?: string;
  };
  board_updated: {
    action: string;
    stateId?: string;
    timestamp: string;
    correlation_id?: string;
  };
  wave_event_injected: {
    eventId: string;
    eventType: string;
    workspace: string;
    timestamp: string;
    correlation_id?: string;
  };
  wave_event_resolved: {
    eventId: string;
    eventType: string;
    action: "apply" | "reject";
    workspace: string;
    timestamp: string;
    correlation_id?: string;
  };
  stuck_detected: {
    stateId: string;
    strategy: string;
    reason: string;
    iteration_count: number;
    comparison: {
      previous: Record<string, unknown>;
      current: Record<string, unknown>;
    };
    timestamp: string;
    correlation_id?: string;
  };
};

// Zod schemas for event payloads — co-located with FlowEventMap interfaces

/** Optional correlation_id field shared by all event shapes. */
const correlationId = z.string().optional();

export const EventPayloadSchemas = {
  agent_spawned: z.object({
    agent: z.string(),
    correlation_id: correlationId,
    model: z.string(),
    role: z.string().optional(),
    stateId: z.string(),
    timestamp: z.string(),
  }),

  board_updated: z.object({
    action: z.string(),
    correlation_id: correlationId,
    stateId: z.string().optional(),
    timestamp: z.string(),
  }),

  flow_completed: z.object({
    concerns: z.array(z.unknown()),
    correlation_id: correlationId,
    duration_ms: z.number(),
    flowName: z.string(),
    skipped: z.array(z.string()),
    task: z.string(),
    timestamp: z.string(),
    totalSpawns: z.number(),
  }),

  flow_started: z.object({
    correlation_id: correlationId,
    flowName: z.string(),
    task: z.string(),
    tier: z.string(),
    timestamp: z.string(),
    workspace: z.string(),
  }),

  hitl_triggered: z.object({
    correlation_id: correlationId,
    iterationCount: z.number().optional(),
    reason: z.string(),
    stateId: z.string(),
    stuckHistory: z.array(z.unknown()).optional(),
    timestamp: z.string(),
  }),

  state_completed: z.object({
    artifacts: z.array(z.string()),
    correlation_id: correlationId,
    discovered_gates_count: z.number().optional(),
    discovered_postconditions_count: z.number().optional(),
    duration_ms: z.number(),
    files_changed: z.number().optional(),
    gate_results: z.array(z.unknown()).optional(),
    postcondition_results: z.array(z.unknown()).optional(),
    result: z.string(),
    stateId: z.string(),
    test_results: z.unknown().optional(),
    timestamp: z.string(),
    violation_count: z.number().optional(),
    violation_severities: z.unknown().optional(),
  }),
  state_entered: z.object({
    correlation_id: correlationId,
    iterationCount: z.number(),
    stateId: z.string(),
    stateType: z.string(),
    timestamp: z.string(),
  }),

  stuck_detected: z.object({
    comparison: z.object({
      current: z.record(z.string(), z.unknown()),
      previous: z.record(z.string(), z.unknown()),
    }),
    correlation_id: correlationId,
    iteration_count: z.number(),
    reason: z.string(),
    stateId: z.string(),
    strategy: z.string(),
    timestamp: z.string(),
  }),

  transition_evaluated: z.object({
    correlation_id: correlationId,
    nextState: z.string(),
    normalizedCondition: z.string(),
    stateId: z.string(),
    statusKeyword: z.string(),
    timestamp: z.string(),
  }),

  wave_event_injected: z.object({
    correlation_id: correlationId,
    eventId: z.string(),
    eventType: z.string(),
    timestamp: z.string(),
    workspace: z.string(),
  }),

  wave_event_resolved: z.object({
    action: z.enum(["apply", "reject"]),
    correlation_id: correlationId,
    eventId: z.string(),
    eventType: z.string(),
    timestamp: z.string(),
    workspace: z.string(),
  }),
} satisfies Record<FlowEventType, z.ZodTypeAny>;

/**
 * Validate an event payload against its schema.
 *
 * Returns a result object — never throws (errors-are-values).
 * Unknown event types pass through without validation (forward-compatible).
 */
export function validateEventPayload(
  type: string,
  payload: Record<string, unknown>,
): { valid: boolean; errors?: string[] } {
  const schema = EventPayloadSchemas[type as FlowEventType];
  if (!schema) return { valid: true };
  const result = schema.safeParse(payload);
  if (result.success) return { valid: true };
  return { errors: result.error.issues.map((i: { message: string }) => i.message), valid: false };
}

export class FlowEventBus extends EventEmitter {
  emit<T extends FlowEventType>(type: T, event: FlowEventMap[T]): boolean {
    return super.emit(type, event);
  }

  on<T extends FlowEventType>(type: T, handler: (event: FlowEventMap[T]) => void): this {
    return super.on(type, handler);
  }
}

export function createMetricsAccumulator(): {
  handler: (type: FlowEventType, event: Record<string, unknown>) => void;
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

  const handler = (type: FlowEventType, event: Record<string, unknown>) => {
    if (type === "agent_spawned") {
      totalSpawns++;
      const stateId = event.stateId as string;
      ensureState(stateId);
      perState[stateId].spawns++;
    } else if (type === "state_completed") {
      const durationMs = event.duration_ms as number;
      const stateId = event.stateId as string;
      totalDuration += durationMs;
      ensureState(stateId);
      perState[stateId].duration_ms += durationMs;
    }
  };

  const getMetrics = () => ({
    perState,
    totalDuration,
    totalSpawns,
  });

  return { getMetrics, handler };
}
