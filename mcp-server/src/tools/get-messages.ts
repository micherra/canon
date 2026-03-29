import { readMessages, type Message } from "../orchestration/messages.ts";
import { readPendingEvents } from "../orchestration/wave-events.ts";
import type { WaveEvent } from "../orchestration/flow-schema.ts";

export interface GetMessagesInput {
  workspace: string;
  channel: string;
  since?: string;
  include_events?: boolean;
}

export interface GetMessagesResult {
  messages: Message[];
  count: number;
  events?: WaveEvent[];
  events_count?: number;
}

export async function getMessages(input: GetMessagesInput): Promise<GetMessagesResult> {
  const messages = await readMessages(input.workspace, input.channel, {
    since: input.since,
  });

  const result: GetMessagesResult = { messages, count: messages.length };

  if (input.include_events) {
    const events = await readPendingEvents(input.workspace);
    result.events = events;
    result.events_count = events.length;
  }

  return result;
}
