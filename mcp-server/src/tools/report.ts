import { DriftStore, DecisionEntry, PatternEntry, ReviewEntry } from "../drift/store.js";
import { randomBytes } from "crypto";
import { z } from "zod";

// --- Discriminated union: each variant carries only its own fields ---

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

export interface ReportOutput {
  recorded: boolean;
  id: string;
  note: string;
}

export async function report(
  input: ReportInput,
  projectDir: string
): Promise<ReportOutput> {
  const store = new DriftStore(projectDir);

  switch (input.type) {
    case "decision":
      return recordDecision(input, store);
    case "pattern":
      return recordPattern(input, store);
    case "review":
      return recordReview(input, store);
  }
}

async function recordDecision(
  decision: Extract<ReportInput, { type: "decision" }>,
  store: DriftStore
): Promise<ReportOutput> {
  const id = generateId("dec");

  const entry: DecisionEntry = {
    decision_id: id,
    timestamp: new Date().toISOString(),
    principle_id: decision.principle_id,
    file_path: decision.file_path,
    justification: decision.justification,
    ...(decision.category ? { category: decision.category } : {}),
  };

  await store.appendDecision(entry);

  return {
    recorded: true,
    id,
    note: "Deviation logged. This will be surfaced in drift reports.",
  };
}

async function recordPattern(
  pattern: Extract<ReportInput, { type: "pattern" }>,
  store: DriftStore
): Promise<ReportOutput> {
  const id = generateId("pat");

  const entry: PatternEntry = {
    pattern_id: id,
    timestamp: new Date().toISOString(),
    pattern: pattern.pattern,
    file_paths: pattern.file_paths,
    context: pattern.context ?? "",
  };

  await store.appendPattern(entry);

  return {
    recorded: true,
    id,
    note: "Pattern observation logged. The learner will validate this in the next /canon:learn run.",
  };
}

async function recordReview(
  review: Extract<ReportInput, { type: "review" }>,
  store: DriftStore
): Promise<ReportOutput> {
  const violatedIds = new Set(review.violations.map((v) => v.principle_id));
  const cleanHonored = review.honored.filter((id) => !violatedIds.has(id));
  const id = generateId("rev");

  const entry: ReviewEntry = {
    review_id: id,
    timestamp: new Date().toISOString(),
    verdict: review.verdict ?? deriveVerdict(review.violations),
    files: review.files,
    violations: review.violations,
    honored: cleanHonored,
    score: review.score,
  };

  await store.appendReview(entry);

  return {
    recorded: true,
    id,
    note: "Review logged. Results will appear in drift reports and inform learning suggestions.",
  };
}

function deriveVerdict(violations: { severity: string }[]): "BLOCKING" | "WARNING" | "CLEAN" {
  if (violations.some((v) => v.severity === "rule")) return "BLOCKING";
  if (violations.some((v) => v.severity === "strong-opinion")) return "WARNING";
  return "CLEAN";
}

function generateId(prefix: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${prefix}_${y}${m}${d}_${randomBytes(2).toString("hex")}`;
}
