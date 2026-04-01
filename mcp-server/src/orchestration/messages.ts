/**
 * Unified messaging system — inter-agent communication via ExecutionStore.
 *
 * Messages are stored in the SQLite messages table. The orchestrator controls
 * who reads what and when via spawn sequencing. Intent (announce, challenge,
 * defend) lives in the message content — like human communication — not in
 * system metadata.
 *
 * Replaced file-based approach (messages/{channel}/*.md) with SQLite rows.
 * The `path` field is no longer produced — callers should use `from` for
 * sender identity and `timestamp` for ordering.
 */

import { getExecutionStore } from "../orchestration/execution-store.ts";

export interface Message {
  /** Sender identity (e.g. "implementor-task-3", "architect-team-a") */
  from: string;
  /** ISO timestamp of when the message was written */
  timestamp: string;
  /** Markdown content — intent is in the words, not metadata */
  content: string;
}

function assertValidChannel(channel: string): void {
  if (!channel.trim()) {
    throw new Error(`Invalid channel: ${channel}`);
  }
  // Guard against path traversal attempts
  const normalized = channel.replace(/\\/g, "/");
  if (normalized.includes("..")) {
    throw new Error(`Invalid channel: ${channel}`);
  }
}

/**
 * Build messaging instructions to inject into agent prompts.
 * Builds coordination instructions injected into wave agent prompts.
 */
export function buildMessageInstructions(
  channel: string,
  peerCount: number,
  workspace: string,
): string {
  return `## Wave Coordination

You are working in parallel with ${peerCount} other agent${peerCount === 1 ? "" : "s"}.

Before creating a new shared utility, helper, or type:
1. Call get_messages(workspace="${workspace}", channel="${channel}") to check if another agent already created it
2. If it exists, import the shared utility they described (using the module path or location documented in their message) instead of creating your own

After creating a shared utility, type, or establishing a pattern:
1. Call post_message(workspace="${workspace}", channel="${channel}", from=YOUR_TASK_ID, content="...")
2. Describe what you created, where it is, and what it exports — so peers can find and import it

If you discover a gotcha (unexpected behavior, env issue, breaking test):
1. Call post_message to warn your peers immediately`;
}

/**
 * Write a message to a workspace channel.
 *
 * Persists to the SQLite messages table via ExecutionStore.
 * Returns the message object with from, timestamp, and content.
 */
export async function writeMessage(
  workspace: string,
  channel: string,
  from: string,
  content: string,
): Promise<Message> {
  assertValidChannel(channel);
  const store = getExecutionStore(workspace);
  const row = store.appendMessage(channel, from, content);
  return {
    from: row.sender,
    timestamp: row.timestamp,
    content: row.content,
  };
}

/**
 * Read all messages from a workspace channel, ordered by id (insertion order).
 *
 * Returns empty array if the channel has no messages.
 * Optionally filters messages by timestamp (since).
 */
export async function readMessages(
  workspace: string,
  channel: string,
  options?: { since?: string },
): Promise<Message[]> {
  assertValidChannel(channel);
  const store = getExecutionStore(workspace);
  const rows = store.getMessages(channel, { since: options?.since });
  return rows.map((r) => ({
    from: r.sender,
    timestamp: r.timestamp,
    content: r.content,
  }));
}

/**
 * Read all messages from a channel and concatenate them into a single
 * markdown string suitable for injection into an agent's prompt.
 *
 * Each message is rendered with a header showing the sender.
 * Returns empty string if the channel has no messages.
 */
export async function readChannelAsContext(
  workspace: string,
  channel: string,
  options?: { maxChars?: number },
): Promise<string> {
  const messages = await readMessages(workspace, channel);
  if (messages.length === 0) return "";

  const maxChars = options?.maxChars ?? 4000;
  const sections: string[] = [];

  for (const msg of messages) {
    sections.push(`**${msg.from}:**\n${msg.content}`);
  }

  let result = sections.join("\n\n---\n\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars).trimEnd() + "\n\n[Messages truncated]";
  }

  return result;
}
