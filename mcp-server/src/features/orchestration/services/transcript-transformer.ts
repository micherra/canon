/**
 * transcript-transformer — Pure function module.
 * Transforms Claude Code JSONL transcript entries to Canon TranscriptEntry[].
 *
 * Claude Code persists agent conversations at:
 *   ~/.claude/projects/{project-id}/{session-id}/subagents/agent-{agentId}.jsonl
 *
 * Each entry in that file is a ClaudeCodeEntry. This module is responsible for
 * mapping those entries to the Canon TranscriptEntry schema (ADR-015).
 *
 * Key design decisions:
 * - Pure: no I/O, no side effects — only transforms data
 * - Fail-safe: malformed entries are skipped, never thrown
 * - validate-at-trust-boundaries: validates with ClaudeCodeEntrySchema before transforming
 */

import type { TranscriptEntry } from "@domains/flows/event-schemas.ts";
import { z } from "zod";

// ----- Claude Code JSONL entry schema (external source — validate at trust boundary) -----

const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    text: z.string(),
    type: z.literal("text"),
  }),
  z.object({
    input: z.unknown().optional(),
    name: z.string(),
    type: z.literal("tool_use"),
  }),
  z.object({
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
    tool_use_id: z.string().optional(),
    type: z.literal("tool_result"),
  }),
]);

const MessageSchema = z.object({
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
  role: z.enum(["user", "assistant"]),
  usage: z
    .object({
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

const ClaudeCodeEntrySchema = z.object({
  agentId: z.string().optional(),
  isSidechain: z.boolean().optional(),
  message: MessageSchema,
  parentUuid: z.string().optional(),
  timestamp: z.string(),
  type: z.enum(["user", "assistant"]),
});

export type ClaudeCodeEntry = z.infer<typeof ClaudeCodeEntrySchema>;

// ----- Transform -----

/**
 * Extract a readable string from a tool_result content field.
 * tool_result.content may be a plain string or an array of blocks.
 */
function extractToolResultContent(content: string | unknown[] | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Flatten text-type blocks from the array
    return content
      .map((item) => {
        if (
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          (item as { type: unknown }).type === "text" &&
          "text" in item
        ) {
          return String((item as { text: unknown }).text);
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  return "";
}

/** Shared token spread fields used when tokens are present. */
type TokenFields = {
  tokens?: number;
  cumulative_tokens?: number;
};

function tokenFields(blockTokens: number | undefined, cumulative: number): TokenFields {
  if (blockTokens == null) return {};
  return { cumulative_tokens: cumulative, tokens: blockTokens };
}

type TransformState = { turnNumber: number; cumulativeTokens: number };

function processStringContent(
  state: TransformState,
  message: { content: string; role: "user" | "assistant"; usage?: { output_tokens?: number } },
  timestamp: string,
): TranscriptEntry {
  state.turnNumber += 1;
  const tokens = message.usage?.output_tokens;
  if (tokens != null) state.cumulativeTokens += tokens;
  return {
    content: message.content,
    role: message.role,
    timestamp,
    turn_number: state.turnNumber,
    ...tokenFields(tokens, state.cumulativeTokens),
  };
}

type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * Process a single content block from an array-content CC entry.
 * Mutates state.turnNumber and state.cumulativeTokens in-place.
 */
function processContentBlock(
  state: TransformState,
  block: ContentBlock,
  blockTokens: number | undefined,
  timestamp: string,
): TranscriptEntry | null {
  state.turnNumber += 1;
  if (blockTokens != null) state.cumulativeTokens += blockTokens;

  if (block.type === "text") {
    return {
      content: block.text,
      role: "assistant",
      timestamp,
      turn_number: state.turnNumber,
      ...tokenFields(blockTokens, state.cumulativeTokens),
    };
  }
  if (block.type === "tool_use") {
    return {
      content: JSON.stringify({ input: block.input ?? {}, tool: block.name }),
      role: "tool_use",
      timestamp,
      tool_name: block.name,
      turn_number: state.turnNumber,
      ...tokenFields(blockTokens, state.cumulativeTokens),
    };
  }
  if (block.type === "tool_result") {
    return {
      content: extractToolResultContent(block.content),
      role: "tool_result",
      timestamp,
      turn_number: state.turnNumber,
      ...tokenFields(blockTokens, state.cumulativeTokens),
    };
  }
  // Unknown block types are skipped (future-proof)
  return null;
}

/**
 * Transform an array of Claude Code JSONL entries to Canon TranscriptEntry[].
 *
 * - Entries that fail schema validation are silently skipped (best-effort).
 * - String content → one Canon entry per CC entry.
 * - Array content → one Canon entry per content block (text / tool_use / tool_result).
 * - turn_number increments per output entry starting at 1.
 * - tokens from message.usage.output_tokens when present.
 * - cumulative_tokens tracks running total across all output entries.
 * - timestamp from the CC entry's timestamp field.
 */
function processArrayContent(
  state: TransformState,
  message: { content: ContentBlock[]; usage?: { output_tokens?: number } },
  timestamp: string,
): TranscriptEntry[] {
  const results: TranscriptEntry[] = [];
  let tokensRemainingForEntry = message.usage?.output_tokens;
  for (const block of message.content) {
    const blockTokens = tokensRemainingForEntry;
    tokensRemainingForEntry = undefined;
    const canon = processContentBlock(state, block, blockTokens, timestamp);
    if (canon) results.push(canon);
  }
  return results;
}

export function transformClaudeCodeTranscript(entries: ClaudeCodeEntry[]): TranscriptEntry[] {
  const output: TranscriptEntry[] = [];
  const state = { cumulativeTokens: 0, turnNumber: 0 };

  for (const raw of entries) {
    const parsed = ClaudeCodeEntrySchema.safeParse(raw);
    if (!parsed.success) continue;

    const { message, timestamp } = parsed.data;
    const content = message.content;

    if (typeof content === "string") {
      output.push(processStringContent(state, { ...message, content }, timestamp));
    } else {
      output.push(...processArrayContent(state, { ...message, content }, timestamp));
    }
  }

  return output;
}
