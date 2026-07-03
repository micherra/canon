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

import type { TranscriptEntry } from "@domains/flows/transcript-schemas.ts";
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

/** Usage sub-shape carrying the two cache summands (subset of MessageSchema.usage). */
type CacheUsage = {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

/**
 * Shared cache-token spread fields for an assistant turn. For string content
 * these land on the single assistant entry. For array content, the
 * message-level usage is only non-undefined for the FIRST emitted block
 * (mirroring how output_tokens/cumulative_tokens are threaded) — so cache
 * fields ride on whichever entry is first, regardless of block type
 * (text/tool_use/tool_result), not only on a leading text block.
 */
type CacheFields = {
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
};

function cacheFields(usage: CacheUsage | undefined): CacheFields {
  const fields: CacheFields = {};
  if (usage?.cache_read_input_tokens != null)
    fields.cache_read_tokens = usage.cache_read_input_tokens;
  if (usage?.cache_creation_input_tokens != null) {
    fields.cache_creation_tokens = usage.cache_creation_input_tokens;
  }
  return fields;
}

type TransformState = { turnNumber: number; cumulativeTokens: number };

function processStringContent(
  state: TransformState,
  message: {
    content: string;
    role: "user" | "assistant";
    usage?: { output_tokens?: number } & CacheUsage;
  },
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
    ...(message.role === "assistant" ? cacheFields(message.usage) : {}),
  };
}

type ContentBlock = z.infer<typeof ContentBlockSchema>;

/** Per-block usage carried over from the message level (output tokens + cache summands). */
type BlockUsage = { output_tokens?: number } & CacheUsage;

/**
 * Process a single content block from an array-content CC entry.
 * Mutates state.turnNumber and state.cumulativeTokens in-place.
 */
function processContentBlock(
  state: TransformState,
  block: ContentBlock,
  blockUsage: BlockUsage | undefined,
  timestamp: string,
): TranscriptEntry | null {
  state.turnNumber += 1;
  const blockTokens = blockUsage?.output_tokens;
  if (blockTokens != null) state.cumulativeTokens += blockTokens;

  if (block.type === "text") {
    return {
      content: block.text,
      role: "assistant",
      timestamp,
      turn_number: state.turnNumber,
      ...tokenFields(blockTokens, state.cumulativeTokens),
      ...cacheFields(blockUsage),
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
      ...cacheFields(blockUsage),
    };
  }
  if (block.type === "tool_result") {
    return {
      content: extractToolResultContent(block.content),
      role: "tool_result",
      timestamp,
      turn_number: state.turnNumber,
      ...tokenFields(blockTokens, state.cumulativeTokens),
      ...cacheFields(blockUsage),
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
  message: { content: ContentBlock[]; usage?: BlockUsage },
  timestamp: string,
): TranscriptEntry[] {
  const results: TranscriptEntry[] = [];
  let usageRemainingForEntry = message.usage;
  for (const block of message.content) {
    const blockUsage = usageRemainingForEntry;
    usageRemainingForEntry = undefined;
    const canon = processContentBlock(state, block, blockUsage, timestamp);
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

    const { content, ...rest } = message;

    if (typeof content === "string") {
      output.push(processStringContent(state, { content, ...rest }, timestamp));
    } else {
      output.push(...processArrayContent(state, { content, ...rest }, timestamp));
    }
  }

  return output;
}

// ----- Cache usage aggregation -----

export type CacheUsageAggregate = {
  cache_read_tokens: number;
  cache_creation_tokens: number;
  input_tokens: number;
  /** Omitted (not NaN, not 0) when read + creation + input all sum to zero. */
  cache_hit_ratio?: number;
};

/**
 * Sum cache_read/cache_creation/input tokens across assistant-turn usage
 * objects in the RAW Claude Code entries and derive a cache-hit ratio.
 *
 * Pure: no I/O. Reads ClaudeCodeEntry[] (has input_tokens, the ratio
 * denominator) rather than the transformed TranscriptEntry[].
 *
 * cache_hit_ratio = cache_read / (cache_read + cache_creation + input),
 * summed over assistant turns; omitted when the denominator is zero
 * (decision cache-telemetry-02).
 */
export function aggregateCacheUsage(entries: ClaudeCodeEntry[]): CacheUsageAggregate {
  let cacheRead = 0;
  let cacheCreation = 0;
  let inputTokens = 0;

  for (const raw of entries) {
    const parsed = ClaudeCodeEntrySchema.safeParse(raw);
    if (!parsed.success) continue;

    const { message } = parsed.data;
    if (message.role !== "assistant" || !message.usage) continue;

    cacheRead += message.usage.cache_read_input_tokens ?? 0;
    cacheCreation += message.usage.cache_creation_input_tokens ?? 0;
    inputTokens += message.usage.input_tokens ?? 0;
  }

  const denominator = cacheRead + cacheCreation + inputTokens;
  return {
    cache_creation_tokens: cacheCreation,
    cache_read_tokens: cacheRead,
    input_tokens: inputTokens,
    ...(denominator > 0 ? { cache_hit_ratio: cacheRead / denominator } : {}),
  };
}
