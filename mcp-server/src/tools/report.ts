import { DriftStore } from "../drift/store.js";
import { randomBytes } from "crypto";
import type { ReportInput, DecisionEntry, PatternEntry, ReviewEntry } from "../schema.js";
export { reportInputSchema, type ReportInput } from "../schema.js";

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
    default: {
      const _exhaustive: never = input;
      throw new Error(`Unknown report type`);
    }
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
