import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { resolveEventAgents } from "../orchestration/wave-events.ts";

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

export async function resolveWaveEvent(input: ResolveWaveEventInput): Promise<ResolveWaveEventResult> {
  // Validate: reject requires reason
  if (input.action === "reject" && !input.reason) {
    throw new Error("reason is required when action is reject");
  }

  const store = getExecutionStore(input.workspace);

  // Find the event by ID — getWaveEvents returns all, we filter by id
  const allEvents = store.getWaveEvents();
  const event = allEvents.find((e) => e.id === input.event_id);

  if (!event) {
    throw new Error(`Event not found: ${input.event_id}`);
  }

  // Validate event is pending
  if (event.status !== "pending") {
    throw new Error(`Event ${input.event_id} is already ${event.status}`);
  }

  // Apply or reject the event via store — SQLite UPDATE is naturally atomic
  if (input.action === "apply") {
    store.updateWaveEvent(input.event_id, {
      status: "applied",
      applied_at: new Date().toISOString(),
      ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
    });
  } else {
    store.updateWaveEvent(input.event_id, {
      status: "rejected",
      rejection_reason: input.reason!,
    });
  }

  // Resolve agents for the event type
  const { agents, descriptions } = resolveEventAgents(event.type);

  // Count remaining pending events
  const pending = store.getWaveEvents({ status: "pending" });

  // Emit wave_event_resolved (best-effort — same pattern as inject-wave-event.ts)
  const onWaveEventResolved = (e: import("../orchestration/events.js").FlowEventMap["wave_event_resolved"]) => {
    try {
      store.appendEvent("wave_event_resolved", e as Record<string, unknown>);
    } catch {
      /* best-effort */
    }
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
}
