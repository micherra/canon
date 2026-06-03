import { ConfidenceAnnotationSchema } from "@shared/lib/confidence.ts";
import { CRAFT_BANDS, CRAFT_DIMENSIONS } from "@shared/lib/craft-rubric.ts";
import { z } from "zod";

// --- Craft profile types + Zod validator ---
// Declared before reportInputSchema so CraftProfile is available for ReviewEntry.

export type CraftDimensionRating = {
  dimension: (typeof CRAFT_DIMENSIONS)[number];
  band: (typeof CRAFT_BANDS)[number];
  evidence?: string;
  principle_refs?: string[];
};

export type CraftProfile = {
  ratings: CraftDimensionRating[];
  /**
   * rollup = mean of rated dimensions' band ordinals (1–3, n-a excluded);
   * derived-for-display only, never a stored primitive.
   * Canonical scale: strong=3 / adequate=2 / weak=1.
   * Use craftRollup() from shared/lib/craft-rubric.ts to compute.
   */
  rollup?: number;
};

export const CraftProfileSchema = z.object({
  ratings: z.array(
    z.object({
      band: z.enum(CRAFT_BANDS),
      dimension: z.enum(CRAFT_DIMENSIONS),
      evidence: z.string().optional(),
      principle_refs: z.array(z.string()).optional(),
    }),
  ),
  rollup: z.number().optional(),
});

// --- Report input: review only ---

export const reportInputSchema = z.discriminatedUnion("type", [
  z.object({
    craft_profile: CraftProfileSchema.optional().describe(
      "Optional craft quality profile emitted by the reviewer. When present and valid, " +
        "one craft_profiles row is persisted per distinct subsystem area.",
    ),
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
          confidence: ConfidenceAnnotationSchema.optional().describe(
            "Confidence annotation for this violation (server-computed)",
          ),
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
  craft_profile?: CraftProfile;
};

export type ReviewViolation = ReviewEntry["violations"][number];
