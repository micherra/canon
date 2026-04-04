import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { WaveEvent, WaveEventType } from "../orchestration/flow-schema.ts";
import { generateId } from "../shared/lib/id.ts";

export type InjectWaveEventInput = {
  workspace: string;
  type: WaveEventType;
  payload: {
    task_id?: string;
    description?: string;
    context?: string;
    wave?: number;
  };
};

export type InjectWaveEventResult = {
  event: WaveEvent;
  pending_count: number;
};

export async function injectWaveEvent(input: InjectWaveEventInput): Promise<InjectWaveEventResult> {
  const store = getExecutionStore(input.workspace);

  // Check for an active wave state in the store
  const board = store.getBoard();
  const hasActiveWave =
    board !== null &&
    Object.values(board.states).some((s) => s.wave !== undefined && s.status === "in_progress");

  if (!hasActiveWave) {
    throw new Error(
      "No active wave state found — events can only be injected during wave execution",
    );
  }

  // Create the event
  const event: WaveEvent = {
    id: generateId("evt"),
    payload: input.payload,
    status: "pending",
    timestamp: new Date().toISOString(),
    type: input.type,
  };

  // Persist to store
  store.postWaveEvent({
    id: event.id,
    payload: event.payload,
    status: event.status,
    timestamp: event.timestamp,
    type: event.type,
  });

  // Count pending events
  const pending = store.getWaveEvents({ status: "pending" });

  // Emit wave_event_injected (best-effort — same pattern as update-board.ts)
  const onWaveEventInjected = (
    e: import("../orchestration/events.js").FlowEventMap["wave_event_injected"],
  ) => {
    try {
      store.appendEvent("wave_event_injected", e as Record<string, unknown>);
    } catch {
      /* best-effort */
    }
  };
  flowEventBus.once("wave_event_injected", onWaveEventInjected);
  try {
    flowEventBus.emit("wave_event_injected", {
      eventId: event.id,
      eventType: event.type,
      timestamp: event.timestamp,
      workspace: input.workspace,
    });
  } finally {
    flowEventBus.removeListener("wave_event_injected", onWaveEventInjected);
  }

  return { event, pending_count: pending.length };
}
