import { writeMessage, type Message } from "../orchestration/messages.ts";

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
  const message = await writeMessage(
    input.workspace,
    input.channel,
    input.from,
    input.content,
  );
  return { message };
}
