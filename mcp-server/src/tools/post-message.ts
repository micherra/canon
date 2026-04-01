import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Message } from "../orchestration/messages.ts";

export interface PostMessageInput {
  workspace: string;
  channel: string;
  from: string;
  content: string;
}

export interface PostMessageResult {
  message: Message;
}

export async function postMessage(input: PostMessageInput): Promise<PostMessageResult> {
  const store = getExecutionStore(input.workspace);
  const row = store.appendMessage(input.channel, input.from, input.content);
  const message: Message = {
    from: row.sender,
    timestamp: row.timestamp,
    content: row.content,
  };
  return { message };
}
