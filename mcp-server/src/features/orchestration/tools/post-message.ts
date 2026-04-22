import type { Message } from "@domains/messages/messages.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
export type PostMessageInput = {
  workspace: string;
  channel: string;
  from: string;
  content: string;
};

export type PostMessageResult = {
  message: Message;
};

export async function postMessage(input: PostMessageInput): Promise<PostMessageResult> {
  const store = getExecutionStore(input.workspace);
  const row = store.appendMessage(input.channel, input.from, input.content);
  const message: Message = {
    content: row.content,
    from: row.sender,
    timestamp: row.timestamp,
  };
  return { message };
}
