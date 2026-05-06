import type { Message } from "@domains/messages/messages.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
export type GetMessagesInput = {
  workspace: string;
  channel: string;
  since?: string;
  include_events?: boolean;
};

export type GetMessagesResult = {
  messages: Message[];
  count: number;
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

  return result;
}
