import { postWaveEvent, readPendingEvents } from "../orchestration/wave-events.ts";
import { readBoard } from "../orchestration/board.ts";
import { withBoardLock } from "../orchestration/workspace.ts";
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
  return withBoardLock(input.workspace, async () => {
    const board = await readBoard(input.workspace);

    const hasActiveWave = Object.values(board.states).some(
      (s) => s.wave !== undefined && s.status === "in_progress",
    );

    if (!hasActiveWave) {
      throw new Error(
        "No active wave state found — events can only be injected during wave execution",
      );
    }

    const event = await postWaveEvent(input.workspace, {
      type: input.type,
      payload: input.payload,
    });

    const pending = await readPendingEvents(input.workspace);

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
  });
}
