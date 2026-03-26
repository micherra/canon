import {
  readAllEvents,
  readPendingEvents,
  markEventApplied,
  markEventRejected,
  resolveEventAgents,
} from "../orchestration/wave-events.ts";
import { withBoardLock } from "../orchestration/workspace.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { createJsonlLogger } from "../orchestration/events.ts";

export interface ResolveWaveEventInput {
  workspace: string;
  event_id: string;
  action: "apply" | "reject";
  resolution?: Record<string, unknown>; // only for apply
  reason?: string; // only for reject
}

export interface ResolveWaveEventResult {
  event_id: string;
  action: "apply" | "reject";
  agents: string[];
  descriptions: Record<string, string>;
  pending_count: number;
}

export async function resolveWaveEvent(
  input: ResolveWaveEventInput,
): Promise<ResolveWaveEventResult> {
  return withBoardLock(input.workspace, async () => {
    // Validate: reject requires reason
    if (input.action === "reject" && !input.reason) {
      throw new Error("reason is required when action is reject");
    }

    // Find the event by ID
    const allEvents = await readAllEvents(input.workspace);
    const event = allEvents.find((e) => e.id === input.event_id);

    if (!event) {
      throw new Error(`Event not found: ${input.event_id}`);
    }

    // Validate event is pending
    if (event.status !== "pending") {
      throw new Error(`Event ${input.event_id} is already ${event.status}`);
    }

    // Apply or reject the event
    if (input.action === "apply") {
      await markEventApplied(input.workspace, input.event_id, input.resolution);
    } else {
      await markEventRejected(input.workspace, input.event_id, input.reason!);
    }

    // Resolve agents for the event type
    const { agents, descriptions } = resolveEventAgents(event.type);

    // Count remaining pending events
    const pending = await readPendingEvents(input.workspace);

    // Emit wave_event_resolved (best-effort — same pattern as inject-wave-event.ts)
    const log = createJsonlLogger(input.workspace);
    const onWaveEventResolved = (
      e: import("../orchestration/events.js").FlowEventMap["wave_event_resolved"],
    ) => {
      log("wave_event_resolved", e).catch(() => {});
    };
    flowEventBus.once("wave_event_resolved", onWaveEventResolved);
    try {
      flowEventBus.emit("wave_event_resolved", {
        eventId: input.event_id,
        eventType: event.type,
        action: input.action,
        workspace: input.workspace,
        timestamp: new Date().toISOString(),
      });
    } finally {
      flowEventBus.removeListener("wave_event_resolved", onWaveEventResolved);
    }

    return {
      event_id: input.event_id,
      action: input.action,
      agents,
      descriptions,
      pending_count: pending.length,
    };
  });
}
