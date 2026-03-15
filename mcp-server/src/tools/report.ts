import { DriftStore, DecisionEntry, ReviewEntry } from "../drift/store.js";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
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
  switch (input.type) {
    case "decision":
      return reportDecision(input, projectDir);
    case "pattern":
      return reportPattern(input, projectDir);
    case "review":
      return reportReview(input, projectDir);
  }
}

async function reportDecision(
  data: Extract<ReportInput, { type: "decision" }>,
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
  data: Extract<ReportInput, { type: "pattern" }>,
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
  data: Extract<ReportInput, { type: "review" }>,
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

function deriveVerdict(data: Extract<ReportInput, { type: "review" }>): "BLOCKING" | "WARNING" | "CLEAN" {
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
