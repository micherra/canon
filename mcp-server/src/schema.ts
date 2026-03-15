import { z } from "zod";

// --- Report input: discriminated union of decision, pattern, review ---

export const reportInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("decision"),
    principle_id: z.string().describe("ID of the principle being deviated from"),
    file_path: z.string().describe("Path of the file where the deviation occurs"),
    justification: z.string().describe("Why the deviation is intentional and justified"),
    category: z
      .enum(["performance", "legacy-constraint", "scope-mismatch", "intentional-tradeoff", "external-requirement", "other"])
      .optional()
      .describe("Deviation category for clustering"),
  }),
  z.object({
    type: z.literal("pattern"),
    pattern: z.string().describe("Description of the observed pattern"),
    file_paths: z.array(z.string()).min(1).describe("File paths where the pattern was observed"),
    context: z.string().optional().describe("Additional context"),
  }),
  z.object({
    type: z.literal("review"),
    files: z.array(z.string()).describe("File paths that were reviewed"),
    violations: z
      .array(z.object({ principle_id: z.string(), severity: z.string() }))
      .describe("Principle violations found"),
    honored: z.array(z.string()).describe("IDs of principles honored"),
    score: z.object({
      rules: z.object({ passed: z.number(), total: z.number() }),
      opinions: z.object({ passed: z.number(), total: z.number() }),
      conventions: z.object({ passed: z.number(), total: z.number() }),
    }),
    verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]).optional(),
  }),
]);

export type ReportInput = z.infer<typeof reportInputSchema>;

// --- Storage entry types: report input fields + storage metadata ---

type DecisionInput = Extract<ReportInput, { type: "decision" }>;
type PatternInput = Extract<ReportInput, { type: "pattern" }>;
type ReviewInput = Extract<ReportInput, { type: "review" }>;

export type DecisionEntry = Omit<DecisionInput, "type"> & {
  decision_id: string;
  timestamp: string;
};

export type PatternEntry = Omit<PatternInput, "type"> & {
  pattern_id: string;
  timestamp: string;
  context: string; // defaults to "" when input omits it
};

export type ReviewEntry = Omit<ReviewInput, "type" | "verdict"> & {
  review_id: string;
  timestamp: string;
  verdict: "BLOCKING" | "WARNING" | "CLEAN"; // required in storage (derived if omitted in input)
};

export type ReviewViolation = ReviewEntry["violations"][number];
