import { DriftStore, DecisionEntry, ReviewEntry } from "../drift/store.js";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";

// --- Decision ---

export interface ReportDecisionData {
  principle_id: string;
  file_path: string;
  justification: string;
  category?: string;
}

// --- Pattern ---

export interface ReportPatternData {
  pattern: string;
  file_paths: string[];
  context?: string;
}

// --- Review ---

export interface ReviewViolationInput {
  principle_id: string;
  severity: string;
}

export interface ReviewScoreInput {
  rules: { passed: number; total: number };
  opinions: { passed: number; total: number };
  conventions: { passed: number; total: number };
}

export interface ReportReviewData {
  files: string[];
  violations: ReviewViolationInput[];
  honored: string[];
  score: ReviewScoreInput;
  verdict?: "BLOCKING" | "WARNING" | "CLEAN";
}

// --- Unified input/output ---

export type ReportInput =
  | { type: "decision"; data: ReportDecisionData }
  | { type: "pattern"; data: ReportPatternData }
  | { type: "review"; data: ReportReviewData };

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
      return reportDecision(input.data, projectDir);
    case "pattern":
      return reportPattern(input.data, projectDir);
    case "review":
      return reportReview(input.data, projectDir);
  }
}

async function reportDecision(
  data: ReportDecisionData,
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
  data: ReportPatternData,
  projectDir: string
): Promise<ReportOutput> {
  if (data.file_paths.length === 0) {
    return {
      recorded: false,
      id: "",
      note: "At least one file path is required to record a pattern observation.",
    };
  }

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
  data: ReportReviewData,
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

function deriveVerdict(data: ReportReviewData): "BLOCKING" | "WARNING" | "CLEAN" {
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
