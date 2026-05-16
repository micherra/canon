/**
 * Zod schemas and TypeScript types for Canon transcript contracts.
 *
 * This file contains types belonging to the "events" bounded context:
 * transcript entries (ADR-015).
 *
 * Bounded context: Events / Quality Contracts
 * See: decompose-by-domain-not-layer, information-hiding
 */

import { z } from "zod";

// Transcript types (ADR-015)

export const TranscriptEntrySchema = z.object({
  content: z.string(),
  cumulative_tokens: z.number().optional(),
  role: z.enum(["system", "user", "assistant", "tool_use", "tool_result"]),
  timestamp: z.string(),
  tokens: z.number().optional(),
  tool_name: z.string().optional(),
  turn_number: z.number(),
});

export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;
