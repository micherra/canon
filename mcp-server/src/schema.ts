import { z } from "zod";

// --- Report input: review only ---

export const reportInputSchema = z.discriminatedUnion("type", [
  z.object({
    files: z.array(z.string()).max(1000).describe("File paths that were reviewed"),
    honored: z.array(z.string()).max(1000).describe("IDs of principles honored"),
    score: z.object({
      conventions: z.object({ passed: z.number(), total: z.number() }),
      opinions: z.object({ passed: z.number(), total: z.number() }),
      rules: z.object({ passed: z.number(), total: z.number() }),
    }),
    type: z.literal("review"),
    verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]).optional(),
    violations: z
      .array(
        z.object({
          file_path: z.string().optional().describe("Specific file where violation occurred"),
          impact_score: z
            .number()
            .optional()
            .describe("Graph-derived impact score (higher = more dependents affected)"),
          message: z.string().optional().describe("Human-readable violation reason"),
          principle_id: z.string(),
          severity: z.string(),
        }),
      )
      .max(1000)
      .describe("Principle violations found"),
  }),
]);

export type ReportInput = z.infer<typeof reportInputSchema>;

// --- Storage entry types: report input fields + storage metadata ---

type ReviewInput = Extract<ReportInput, { type: "review" }>;

export type ReviewEntry = Omit<ReviewInput, "type" | "verdict"> & {
  review_id: string;
  timestamp: string;
  verdict: "BLOCKING" | "WARNING" | "CLEAN"; // required in storage (derived if omitted in input)
  pr_number?: number;
  branch?: string;
  last_reviewed_sha?: string;
  file_priorities?: Array<{ path: string; priority_score: number }>;
  recommendations?: Array<{
    file_path?: string;
    title: string;
    message: string;
    source: "principle" | "holistic";
  }>;
};

export type ReviewViolation = ReviewEntry["violations"][number];
