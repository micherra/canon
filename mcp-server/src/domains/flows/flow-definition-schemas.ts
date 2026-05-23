/**
 * Zod schemas and TypeScript types for Canon quality gate and execution contracts.
 *
 * This file retains only the symbols still imported by production code:
 * quality gate results, postcondition contracts, violation/test counts,
 * and the stuck-detection enum used by the execution store.
 *
 * Bounded context: Flow Definitions (quality gate + execution contracts)
 * See: decompose-by-domain-not-layer, information-hiding
 */

import { z } from "zod";

export const StuckWhenSchema = z.enum([
  "same_violations",
  "same_file_test",
  "same_status",
  "no_progress",
  "no_gate_progress",
]);

// Quality gate result schemas

/** Gate result stored on board state (source of truth imported from here, not local interfaces). */
export const GateResultSchema = z.object({
  command: z.string().optional(),
  exitCode: z.number().optional(),
  gate: z.string(),
  output: z.string().optional(),
  passed: z.boolean(),
});

/** Discovered gate command reported by agents (e.g. tester, reviewer). */
export const DiscoveredGateSchema = z.object({
  command: z.string(),
  source: z.string(), // agent that discovered it, e.g. "tester", "reviewer"
});

/** Postcondition assertion declaration (for flow YAML or agent-discovered). */
export const PostconditionAssertionSchema = z.object({
  command: z.string().optional(),
  pattern: z.string().optional(),
  target: z.string().optional(),
  type: z.enum(["file_exists", "file_changed", "pattern_match", "no_pattern", "bash_check"]),
});

/** Postcondition evaluation result. */
export const PostconditionResultSchema = z.object({
  name: z.string(),
  output: z.string().optional(),
  passed: z.boolean(),
  type: z.string(),
});

/** Violation severity counts. */
export const ViolationSeveritiesSchema = z.object({
  blocking: z.number(),
  warning: z.number(),
});

/** Test result counts. */
export const TestResultsSchema = z.object({
  failed: z.number(),
  passed: z.number(),
  skipped: z.number(),
});

// Inferred TypeScript types

export type StuckWhen = z.infer<typeof StuckWhenSchema>;
export type GateResult = z.infer<typeof GateResultSchema>;
export type DiscoveredGate = z.infer<typeof DiscoveredGateSchema>;
export type PostconditionAssertion = z.infer<typeof PostconditionAssertionSchema>;
export type PostconditionResult = z.infer<typeof PostconditionResultSchema>;
export type ViolationSeverities = z.infer<typeof ViolationSeveritiesSchema>;
export type TestResults = z.infer<typeof TestResultsSchema>;
