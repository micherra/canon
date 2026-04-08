/**
 * Zod schemas and TypeScript types for Canon transcript and wave event contracts.
 *
 * This file contains types belonging to the "events" bounded context:
 * transcript entries (ADR-015) and wave event types used by wave coordination.
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

// Wave event types (used by wave-events.ts, inject-wave-event.ts, etc.)

export type WaveEventType =
  | "add_task"
  | "skip_task"
  | "reprioritize"
  | "inject_context"
  | "guidance"
  | "pause";

export type WaveEventResolution = Record<string, unknown>;

export type WaveEvent = {
  id: string;
  type: WaveEventType;
  payload: Record<string, unknown>;
  timestamp: string;
  status: "pending" | "applied" | "rejected";
  applied_at?: string;
  resolution?: WaveEventResolution;
  rejection_reason?: string;
};
