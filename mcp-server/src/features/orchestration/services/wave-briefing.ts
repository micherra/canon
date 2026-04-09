/**
 * Wave briefing assembler — produces a human-readable briefing string
 * summarising what prior-wave agents learned and any consultation outputs.
 *
 * INPUT CONTRACT:
 *   When called via the prompt assembly pipeline (ADR-006), escaping is handled
 *   by stage 6 (inject-wave-briefing) before calling this function. Direct
 *   callers outside the pipeline must still pre-escape text.
 *
 *   This module does NOT escape input — it trusts that ${...} patterns in
 *   summaries and consultationOutputs have already been neutralised to \${...}
 *   so that substituteVariables cannot expand them unintentionally.
 */

import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Maximum character length of the assembled briefing before truncation. */
const MAX_BRIEFING_CHARS = 2000;

export type WaveBriefingInput = {
  wave: number;
  consultationOutputs: Record<string, { section?: string; summary: string }>;
  // section = heading from ConsultationFragment.section (pre-escaped by caller or stage 6)
};

/**
 * Assemble a wave briefing string from consultation outputs.
 *
 * Wave summaries now flow through inject_context events rather than being
 * parsed here. This function focuses on consultation outputs from architects
 * and advisors that ran before the wave.
 *
 * Sections that contain no matching content are omitted entirely.
 * The final output is truncated to ~2000 characters (~500 tokens) if needed.
 *
 * Input text must already be escaped — either by the pipeline (stage 6) or by
 * direct callers. This function does NOT call escapeDollarBrace and does NOT
 * sanitise ${...} patterns in input.
 */
export function assembleWaveBriefing(input: WaveBriefingInput): string {
  const { wave, consultationOutputs } = input;

  const sections: string[] = [];
  sections.push(`## Wave Briefing (from wave ${wave})`);

  // Append consultation output sections
  for (const output of Object.values(consultationOutputs)) {
    if (output.section) {
      sections.push(`\n### ${output.section}\n${output.summary}`);
    }
  }

  let result = sections.join("").trimEnd();

  if (result.length > MAX_BRIEFING_CHARS) {
    result = `${result.slice(0, MAX_BRIEFING_CHARS).trimEnd()}\n\n[Briefing truncated]`;
  }

  return result;
}

// Wave guidance persistence

const GUIDANCE_FILE = "waves/guidance.md";

/**
 * Read wave guidance from ${workspace}/waves/guidance.md.
 * Returns empty string if the file does not exist.
 */
export async function readWaveGuidance(workspace: string): Promise<string> {
  const filePath = join(workspace, GUIDANCE_FILE);
  try {
    await access(filePath);
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Append guidance to ${workspace}/waves/guidance.md, creating the file and
 * directory if needed. Entries are separated by a markdown horizontal rule.
 */
export async function writeWaveGuidance(workspace: string, guidance: string): Promise<void> {
  const filePath = join(workspace, GUIDANCE_FILE);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `\n\n---\n\n${guidance}`);
}
