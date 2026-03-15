import { DriftStore, DecisionEntry, ReviewEntry } from "../drift/store.js";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { z } from "zod";

// --- Variant schemas for discriminated validation ---

const decisionSchema = z.object({
  principle_id: z.string(),
  file_path: z.string(),
  justification: z.string(),
  category: z.enum(["performance", "legacy-constraint", "scope-mismatch", "intentional-tradeoff", "external-requirement", "other"]).optional(),
});

const patternSchema = z.object({
  pattern: z.string(),
  file_paths: z.array(z.string()).min(1),
  context: z.string().optional(),
});

const reviewSchema = z.object({
  files: z.array(z.string()),
  violations: z.array(z.object({ principle_id: z.string(), severity: z.string() })),
  honored: z.array(z.string()),
  score: z.object({
    rules: z.object({ passed: z.number(), total: z.number() }),
    opinions: z.object({ passed: z.number(), total: z.number() }),
    conventions: z.object({ passed: z.number(), total: z.number() }),
  }),
  verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]).optional(),
});

// --- Raw shape for server.tool (visible to clients as JSON Schema) ---

export const reportToolShape = {
  type: z.enum(["decision", "pattern", "review"]).describe("Type of report"),
  decision: decisionSchema.optional().describe("Required when type=decision: deviation details"),
  pattern: patternSchema.optional().describe("Required when type=pattern: observed pattern details"),
  review: reviewSchema.optional().describe("Required when type=review: code review results"),
} as const;

// --- Discriminated validation applied after parsing ---

const reportBaseSchema = z.object(reportToolShape);

export const reportInputSchema = reportBaseSchema.superRefine((val, ctx) => {
  if (val.type === "decision" && !val.decision) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"], message: "decision field is required when type=decision" });
  }
  if (val.type === "pattern" && !val.pattern) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pattern"], message: "pattern field is required when type=pattern" });
  }
  if (val.type === "review" && !val.review) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["review"], message: "review field is required when type=review" });
  }
});

export type ReportInput = z.infer<typeof reportBaseSchema>;

export interface ReportOutput {
  recorded: boolean;
  id: string;
  note: string;
}

type DecisionData = z.infer<typeof decisionSchema>;
type PatternData = z.infer<typeof patternSchema>;
type ReviewData = z.infer<typeof reviewSchema>;

export async function report(
  input: ReportInput,
  projectDir: string
): Promise<ReportOutput> {
  switch (input.type) {
    case "decision":
      return reportDecision(input.decision!, projectDir);
    case "pattern":
      return reportPattern(input.pattern!, projectDir);
    case "review":
      return reportReview(input.review!, projectDir);
  }
}

async function reportDecision(
  data: DecisionData,
  projectDir: string
): Promise<ReportOutput> {
  const id = `dec_${formatDate()}_${randomBytes(2).toString("hex")}`;

  const entry: DecisionEntry = {
    decision_id: id,
    timestamp: new Date().toISOString(),
    principle_id: data.principle_id,
    file_path: data.file_path,
    justification: data.justification,
    ...(data.category ? { category: data.category } : {}),
  };

  const store = new DriftStore(projectDir);
  await store.appendDecision(entry);

  return {
    recorded: true,
    id,
    note: "Deviation logged. This will be surfaced in drift reports.",
  };
}

async function reportPattern(
  data: PatternData,
  projectDir: string
): Promise<ReportOutput> {
  const id = `pat_${formatDate()}_${randomBytes(2).toString("hex")}`;

  const entry = {
    pattern_id: id,
    timestamp: new Date().toISOString(),
    pattern: data.pattern,
    file_paths: data.file_paths,
    context: data.context ?? "",
  };

  const filePath = join(projectDir, ".canon", "patterns.jsonl");
  await mkdir(join(projectDir, ".canon"), { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

  return {
    recorded: true,
    id,
    note: "Pattern observation logged. The learner will validate this in the next /canon:learn run.",
  };
}

async function reportReview(
  data: ReviewData,
  projectDir: string
): Promise<ReportOutput> {
  const violatedIds = new Set(data.violations.map((v) => v.principle_id));
  const cleanHonored = data.honored.filter((id) => !violatedIds.has(id));

  const id = `rev_${formatDate()}_${randomBytes(2).toString("hex")}`;

  const verdict = data.verdict ?? deriveVerdict(data);

  const entry: ReviewEntry = {
    review_id: id,
    timestamp: new Date().toISOString(),
    verdict,
    files: data.files,
    violations: data.violations,
    honored: cleanHonored,
    score: data.score,
  };

  const store = new DriftStore(projectDir);
  await store.appendReview(entry);

  return {
    recorded: true,
    id,
    note: "Review logged. Results will appear in drift reports and inform learning suggestions.",
  };
}

function deriveVerdict(data: ReviewData): "BLOCKING" | "WARNING" | "CLEAN" {
  if (data.violations.some((v) => v.severity === "rule")) return "BLOCKING";
  if (data.violations.some((v) => v.severity === "strong-opinion")) return "WARNING";
  return "CLEAN";
}

function formatDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
