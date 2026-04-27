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

import { z } from "zod";
import type { TranscriptEntry } from "@domains/flows/event-schemas.ts";

// ----- Claude Code JSONL entry schema (external source — validate at trust boundary) -----

const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool_use"),
    name: z.string(),
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string().optional(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
  }),
]);

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
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
function extractToolResultContent(
  content: string | unknown[] | undefined,
): string {
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
export function transformClaudeCodeTranscript(
  entries: ClaudeCodeEntry[],
): TranscriptEntry[] {
  const output: TranscriptEntry[] = [];
  let turnNumber = 0;
  let cumulativeTokens = 0;

  for (const raw of entries) {
    const parsed = ClaudeCodeEntrySchema.safeParse(raw);
    if (!parsed.success) continue;

    const entry = parsed.data;
    const { message, timestamp } = entry;
    const outputTokens = message.usage?.output_tokens;

    if (typeof message.content === "string") {
      // Simple string content — one output entry
      turnNumber += 1;
      const tokens = outputTokens;
      if (tokens != null) cumulativeTokens += tokens;

      const canon: TranscriptEntry = {
        content: message.content,
        role: message.role,
        timestamp,
        turn_number: turnNumber,
        ...(tokens != null ? { tokens } : {}),
        ...(tokens != null ? { cumulative_tokens: cumulativeTokens } : {}),
      };
      output.push(canon);
    } else {
      // Array of content blocks — one output entry per block
      // tokens are attributed to the first block from the same CC entry
      let tokensRemainingForEntry = outputTokens;

      for (const block of message.content) {
        turnNumber += 1;

        // Attribute tokens to the first block from this CC entry
        const blockTokens = tokensRemainingForEntry;
        tokensRemainingForEntry = undefined; // only first block gets the tokens

        if (blockTokens != null) cumulativeTokens += blockTokens;

        if (block.type === "text") {
          const canon: TranscriptEntry = {
            content: block.text,
            role: "assistant",
            timestamp,
            turn_number: turnNumber,
            ...(blockTokens != null ? { tokens: blockTokens } : {}),
            ...(blockTokens != null ? { cumulative_tokens: cumulativeTokens } : {}),
          };
          output.push(canon);
        } else if (block.type === "tool_use") {
          const canon: TranscriptEntry = {
            content: JSON.stringify({ tool: block.name, input: block.input ?? {} }),
            role: "tool_use",
            timestamp,
            tool_name: block.name,
            turn_number: turnNumber,
            ...(blockTokens != null ? { tokens: blockTokens } : {}),
            ...(blockTokens != null ? { cumulative_tokens: cumulativeTokens } : {}),
          };
          output.push(canon);
        } else if (block.type === "tool_result") {
          const canon: TranscriptEntry = {
            content: extractToolResultContent(block.content),
            role: "tool_result",
            timestamp,
            turn_number: turnNumber,
            ...(blockTokens != null ? { tokens: blockTokens } : {}),
            ...(blockTokens != null ? { cumulative_tokens: cumulativeTokens } : {}),
          };
          output.push(canon);
        }
        // Unknown block types are skipped (future-proof)
      }
    }
  }

  return output;
}
