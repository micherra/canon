import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";

export interface ReportPatternInput {
  pattern: string;
  file_paths: string[];
  context?: string;
}

export interface ReportPatternOutput {
  recorded: boolean;
  pattern_id: string;
  note: string;
}

export async function reportPattern(
  input: ReportPatternInput,
  projectDir: string
): Promise<ReportPatternOutput> {
  if (input.file_paths.length === 0) {
    return {
      recorded: false,
      pattern_id: "",
      note: "At least one file path is required to record a pattern observation.",
    };
  }

  const patternId = `pat_${formatDate()}_${randomBytes(2).toString("hex")}`;
  const timestamp = new Date().toISOString();

  const entry = {
    pattern_id: patternId,
    timestamp,
    pattern: input.pattern,
    file_paths: input.file_paths,
    context: input.context ?? "",
  };

  const filePath = join(projectDir, ".canon", "patterns.jsonl");

  try {
    await mkdir(join(projectDir, ".canon"), { recursive: true });
    await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err: unknown) {
    throw err;
  }

  return {
    recorded: true,
    pattern_id: patternId,
    note: "Pattern observation logged. The learner will validate this against the codebase in the next /canon:learn run.",
  };
}

function formatDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
