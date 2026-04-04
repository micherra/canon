import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { WaveEvent } from "../orchestration/flow-schema.ts";
import type { Message } from "../orchestration/messages.ts";

export type GetMessagesInput = {
  workspace: string;
  channel: string;
  since?: string;
  include_events?: boolean;
};

export type GetMessagesResult = {
  messages: Message[];
  count: number;
  events?: WaveEvent[];
  events_count?: number;
};

export async function getMessages(input: GetMessagesInput): Promise<GetMessagesResult> {
  const store = getExecutionStore(input.workspace);
  const rows = store.getMessages(input.channel, { since: input.since });
  const messages: Message[] = rows.map((r) => ({
    content: r.content,
    from: r.sender,
    timestamp: r.timestamp,
  }));

  const result: GetMessagesResult = { count: messages.length, messages };

  if (input.include_events) {
    const events = store.getWaveEvents({ status: "pending" });
    result.events = events;
    result.events_count = events.length;
  }

  return result;
}
