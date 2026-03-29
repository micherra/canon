/**
 * Unified messaging system — unified inter-agent communication.
 *
 * Messages are markdown files in workspace channels. The orchestrator controls
 * who reads what and when via spawn sequencing. Intent (announce, challenge,
 * defend) lives in the message content — like human communication — not in
 * system metadata.
 *
 * File layout:
 *   ${workspace}/messages/${channel}/${NNN}-${from-slug}.md
 *
 * Each message file has an HTML comment header for metadata:
 *   <!-- from: implementor-auth | 2026-03-28T10:15:00Z -->
 */

import { readFile, writeFile, readdir, mkdir, access, rm } from "fs/promises";
import { join, resolve, relative } from "path";

export interface Message {
  /** Sender identity (e.g. "implementor-task-3", "architect-team-a") */
  from: string;
  /** ISO timestamp of when the message was written */
  timestamp: string;
  /** Markdown content — intent is in the words, not metadata */
  content: string;
  /** Path to the message file on disk */
  path: string;
}

function assertValidChannelDir(workspace: string, channel: string): string {
  const messagesRoot = resolve(workspace, "messages");
  const resolvedChannel = resolve(messagesRoot, channel);
  const rel = relative(messagesRoot, resolvedChannel);
  const relSegments = rel.split(/[\\/]+/).filter(Boolean);

  if (!channel.trim() || rel === "" || rel.startsWith("..") || relSegments.includes("..")) {
    throw new Error(`Invalid channel: ${channel}`);
  }

  return resolvedChannel;
}

/**
 * Sanitize a string for use in filenames: lowercase, replace non-alphanum with hyphens, collapse.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Compute the channel directory path.
 */
export function channelDir(workspace: string, channel: string): string {
  return assertValidChannelDir(workspace, channel);
}

/**
 * Count existing message files in a channel to determine the next sequence number.
 */
async function nextSequenceNumber(dir: string): Promise<number> {
  try {
    await access(dir);
    const entries = await readdir(dir);
    const mdFiles = entries.filter((e) => e.endsWith(".md"));
    return mdFiles.length + 1;
  } catch {
    return 1;
  }
}

async function reserveSequenceNumber(dir: string): Promise<number> {
  const lockDir = join(dir, ".sequence.lock");
  const counterPath = join(dir, ".sequence");

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await new Promise((resolveLock) => setTimeout(resolveLock, 10));
        continue;
      }
      throw error;
    }
  }

  try {
    let seq: number;
    try {
      const current = await readFile(counterPath, "utf-8");
      seq = Number.parseInt(current, 10) + 1;
    } catch {
      seq = await nextSequenceNumber(dir);
    }

    await writeFile(counterPath, String(seq), "utf-8");
    return seq;
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

/**
 * Write a message to a workspace channel.
 *
 * Creates the channel directory if needed. Returns the full message
 * object including the file path and timestamp.
 */
export async function writeMessage(
  workspace: string,
  channel: string,
  from: string,
  content: string,
): Promise<Message> {
  const dir = channelDir(workspace, channel);
  await mkdir(dir, { recursive: true });

  const slug = slugify(from);
  const timestamp = new Date().toISOString();
  const header = `<!-- from: ${from} | ${timestamp} -->\n\n`;
  const fullContent = header + content;
  let filePath = "";

  while (true) {
    const seq = await reserveSequenceNumber(dir);
    const paddedSeq = String(seq).padStart(3, "0");
    const filename = `${paddedSeq}-${slug}.md`;
    filePath = join(dir, filename);
    try {
      await writeFile(filePath, fullContent, { encoding: "utf-8", flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  return { from, timestamp, content, path: filePath };
}

/**
 * Parse a message file's header to extract metadata.
 */
function parseMessageHeader(raw: string): { from: string; timestamp: string } | null {
  const match = raw.match(/^<!--\s*from:\s*(.+?)\s*\|\s*(.+?)\s*-->/);
  if (!match) return null;
  return { from: match[1], timestamp: match[2] };
}

/**
 * Read all messages from a workspace channel, ordered by filename (sequence number).
 *
 * Returns empty array if the channel doesn't exist.
 * Optionally filters messages by timestamp (since).
 */
export async function readMessages(
  workspace: string,
  channel: string,
  options?: { since?: string },
): Promise<Message[]> {
  const dir = channelDir(workspace, channel);

  try {
    await access(dir);
  } catch {
    return [];
  }

  const entries = await readdir(dir);
  const mdFiles = entries.filter((e) => e.endsWith(".md")).sort();

  const messages: Message[] = [];
  for (const file of mdFiles) {
    const filePath = join(dir, file);
    const raw = await readFile(filePath, "utf-8");
    const header = parseMessageHeader(raw);

    if (!header) {
      // Skip files without a valid message header
      continue;
    }

    // Extract content after the header (skip the comment line and blank line)
    const contentStart = raw.indexOf("-->\n");
    const content = contentStart !== -1
      ? raw.slice(contentStart + 4).replace(/^\n+/, "")
      : raw;

    messages.push({
      from: header.from,
      timestamp: header.timestamp,
      content,
      path: filePath,
    });
  }

  // Apply since filter
  if (options?.since) {
    const sinceMs = new Date(options.since).getTime();
    return messages.filter((m) => new Date(m.timestamp).getTime() > sinceMs);
  }

  return messages;
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
2. If it exists, import from their path instead of creating your own

After creating a shared utility, type, or establishing a pattern:
1. Call post_message(workspace="${workspace}", channel="${channel}", from=YOUR_TASK_ID, content="...")
2. Describe what you created, where it is, and what it exports — so peers can find and import it

If you discover a gotcha (unexpected behavior, env issue, breaking test):
1. Call post_message to warn your peers immediately`;
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
