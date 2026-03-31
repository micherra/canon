import { getExecutionStore } from "../orchestration/execution-store.ts";
import { generateId } from "../utils/id.ts";
import { flowEventBus } from "../orchestration/event-bus-instance.ts";
import { createJsonlLogger } from "../orchestration/events.ts";
import type { WaveEvent, WaveEventType } from "../orchestration/flow-schema.ts";

export interface InjectWaveEventInput {
  workspace: string;
  type: WaveEventType;
  payload: {
    task_id?: string;
    description?: string;
    context?: string;
    wave?: number;
  };
}

export interface InjectWaveEventResult {
  event: WaveEvent;
  pending_count: number;
}

export async function injectWaveEvent(input: InjectWaveEventInput): Promise<InjectWaveEventResult> {
  const store = getExecutionStore(input.workspace);

  // Check for an active wave state in the store
  const board = store.getBoard();
  const hasActiveWave = board !== null && Object.values(board.states).some(
    (s) => s.wave !== undefined && s.status === "in_progress",
  );

  if (!hasActiveWave) {
    throw new Error(
      "No active wave state found — events can only be injected during wave execution",
    );
  }

  // Create the event
  const event: WaveEvent = {
    id: generateId("evt"),
    type: input.type,
    payload: input.payload,
    timestamp: new Date().toISOString(),
    status: "pending",
  };

  // Persist to store
  store.postWaveEvent({
    id: event.id,
    type: event.type,
    payload: event.payload,
    timestamp: event.timestamp,
    status: event.status,
  });

  // Count pending events
  const pending = store.getWaveEvents({ status: "pending" });

  // Emit wave_event_injected (best-effort — same pattern as update-board.ts)
  const log = createJsonlLogger(input.workspace);
  const onWaveEventInjected = (
    e: import("../orchestration/events.js").FlowEventMap["wave_event_injected"],
  ) => {
    log("wave_event_injected", e).catch(() => {});
  };
  flowEventBus.once("wave_event_injected", onWaveEventInjected);
  try {
    flowEventBus.emit("wave_event_injected", {
      eventId: event.id,
      eventType: event.type,
      workspace: input.workspace,
      timestamp: event.timestamp,
    });
  } finally {
    flowEventBus.removeListener("wave_event_injected", onWaveEventInjected);
  }

  return { event, pending_count: pending.length };
}
