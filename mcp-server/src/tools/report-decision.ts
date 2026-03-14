import { DriftStore, DecisionEntry } from "../drift/store.js";
import { randomBytes } from "crypto";

export interface ReportDecisionInput {
  principle_id: string;
  file_path: string;
  justification: string;
  category?: string;
}

export interface ReportDecisionOutput {
  recorded: boolean;
  decision_id: string;
  note: string;
}

export async function reportDecision(
  input: ReportDecisionInput,
  projectDir: string
): Promise<ReportDecisionOutput> {
  const decisionId = `dec_${formatDate()}_${randomBytes(2).toString("hex")}`;
  const timestamp = new Date().toISOString();

  const entry: DecisionEntry = {
    decision_id: decisionId,
    timestamp,
    principle_id: input.principle_id,
    file_path: input.file_path,
    justification: input.justification,
    ...(input.category ? { category: input.category } : {}),
  };

  const store = new DriftStore(projectDir);
  await store.appendDecision(entry);

  return {
    recorded: true,
    decision_id: decisionId,
    note: "Deviation logged. This will be surfaced in drift reports.",
  };
}

function formatDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
