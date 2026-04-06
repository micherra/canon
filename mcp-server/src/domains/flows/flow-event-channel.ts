/**
 * Flow event channel — drain and interpret events from the "flow-events" channel.
 *
 * Agents and external tooling can post structured events to the "flow-events"
 * channel on a workspace's ExecutionStore. The orchestrator calls drainFlowEvents
 * once per drive-flow cycle to pick up any pending directives and convert them into
 * an actionable effect (insert, skip, escalate) or a no-op (none).
 *
 * ADR-012 / fe-02
 */

import { z } from "zod";
import type { ExecutionStore } from "@domains/workspaces/execution-store.ts";
import type { FlowDefinition, StateDefinition } from "./flow-schema.ts";

// ---------------------------------------------------------------------------
// Event schema (discriminated union)
// ---------------------------------------------------------------------------

const FlowEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request_state"),
    state_id: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("skip_ahead"),
    target: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("escalate"),
    message: z.string(),
    suggested_options: z.array(z.string()).optional(),
  }),
]);

type FlowEvent = z.infer<typeof FlowEventSchema>;

// ---------------------------------------------------------------------------
// Effect types
// ---------------------------------------------------------------------------

export type FlowEventEffect =
  | { type: "none" }
  | { type: "insert"; state_id: string }
  | { type: "skip"; target: string; reason: string }
  | { type: "escalate"; message: string; suggested_options?: string[] };

// ---------------------------------------------------------------------------
// BFS reachability
// ---------------------------------------------------------------------------

/**
 * Returns the set of state IDs reachable from `startId` via forward transition
 * edges in `flowDef.states`. BFS is conservative — all transition edges
 * (on_success, on_failure, and every value in the `transitions` record) are
 * treated as possible paths regardless of runtime conditions.
 *
 * The start state itself is NOT included in the returned set (we want forward
 * reachability only, so "skip_ahead" to the current state is a no-op).
 */
function reachableFrom(startId: string, states: Record<string, StateDefinition>): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [startId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const stateDef = states[current];
    if (!stateDef) continue;

    // Collect all forward edges from this state
    const edges: string[] = [];

    // transitions map (most common edge source)
    if (stateDef.transitions) {
      for (const target of Object.values(stateDef.transitions)) {
        edges.push(target);
      }
    }

    // on_success / on_failure edges used by wave and parallel states
    if ("on_success" in stateDef && typeof stateDef.on_success === "string") edges.push(stateDef.on_success);
    if ("on_failure" in stateDef && typeof stateDef.on_failure === "string") edges.push(stateDef.on_failure);

    for (const edge of edges) {
      if (!visited.has(edge) && edge !== startId) {
        visited.add(edge);
        queue.push(edge);
      }
    }
  }

  return visited;
}

// ---------------------------------------------------------------------------
// Drain function
// ---------------------------------------------------------------------------

export type DrainFlowEventsParams = {
  store: ExecutionStore;
  workspaceId: string;
  currentStateId: string;
  flowDef: FlowDefinition;
  /** Last processed message id (board.metadata.flow_events_watermark ?? 0) */
  watermark: number;
};

export type DrainFlowEventsResult = {
  effect: FlowEventEffect;
  newWatermark: number;
};

/**
 * Drain the "flow-events" channel since the given watermark, parse each message,
 * and return the first actionable effect found along with the updated watermark.
 *
 * Processing rules:
 * - Messages are processed in ascending id order (as returned by getMessagesSinceId).
 * - Malformed or schema-invalid messages are warned and skipped.
 * - First non-none effect wins; remaining messages are still scanned to advance watermark.
 * - The watermark always advances to the max id seen across all messages.
 */
export function drainFlowEvents(params: DrainFlowEventsParams): DrainFlowEventsResult {
  const { store, currentStateId, flowDef, watermark } = params;

  const messages = store.getMessagesSinceId("flow-events", watermark);

  let effect: FlowEventEffect = { type: "none" };
  let newWatermark = watermark;

  for (const msg of messages) {
    // Always advance the watermark to the highest id seen
    if (msg.id > newWatermark) {
      newWatermark = msg.id;
    }

    // Parse the event
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      store.appendEvent("flow_event_skipped", {
        message_id: msg.id,
        reason: "invalid JSON",
      });
      continue;
    }

    const parseResult = FlowEventSchema.safeParse(parsed);
    if (!parseResult.success) {
      store.appendEvent("flow_event_skipped", {
        message_id: msg.id,
        reason: "schema validation failed",
        detail: parseResult.error.message,
      });
      continue;
    }

    // Only process if we haven't already found a winning effect
    if (effect.type === "none") {
      const candidate = resolveEffect(parseResult.data, currentStateId, flowDef);
      if (candidate.type !== "none") {
        effect = candidate;
        // Keep looping to advance watermark past remaining messages
      }
    }
  }

  return { effect, newWatermark };
}

// ---------------------------------------------------------------------------
// Per-event effect resolution
// ---------------------------------------------------------------------------

function resolveEffect(
  event: FlowEvent,
  currentStateId: string,
  flowDef: FlowDefinition,
): FlowEventEffect {
  switch (event.type) {
    case "request_state": {
      const allowed = flowDef.allowed_insertions;
      if (!allowed || !allowed.includes(event.state_id)) {
        return { type: "none" };
      }
      // Guard against whitelisted state IDs that don't exist in the flow definition.
      // Returning insert for a nonexistent state would hand the orchestrator a state
      // it cannot enter, so we fall through to none instead.
      const states = flowDef.states ?? {};
      if (!(event.state_id in states)) {
        return { type: "none" };
      }
      return { type: "insert", state_id: event.state_id };
    }

    case "skip_ahead": {
      const states = flowDef.states ?? {};
      const reachable = reachableFrom(currentStateId, states);
      if (!reachable.has(event.target)) {
        return { type: "none" };
      }
      return { type: "skip", target: event.target, reason: event.reason };
    }

    case "escalate": {
      const eff: FlowEventEffect = { type: "escalate", message: event.message };
      if (event.suggested_options !== undefined) {
        (eff as { type: "escalate"; message: string; suggested_options?: string[] }).suggested_options =
          event.suggested_options;
      }
      return eff;
    }
  }
}
