/**
 * Stage 2 — Inject handoff files from prior pipeline stages.
 *
 * Reads handoff markdown files from {workspace}/handoffs/ and injects their
 * content as the ${handoff_context} variable. The handoff files to read are
 * determined by the agent type executing this state (ctx.state.agent).
 *
 * Behavior:
 * - Unknown agent types: returns ctx unchanged (same reference, no warnings)
 * - Missing handoff files: appends a warning, skips the file (graceful degradation)
 * - All read content is escaped via escapeDollarBrace before entering the
 *   pipeline (trust-boundary sanitizer, same pattern as resolve-context.ts)
 *
 * Canon: handle-partial-failure — missing files produce warnings, never errors.
 * Canon: no-hidden-side-effects — stage is named injectHandoffs and is visible
 *   in the PIPELINE array in assemble-prompt.ts.
 * Canon: simplicity-first — static const lookup table, ~45 lines of logic.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { escapeDollarBrace } from "../../orchestration/wave-variables.ts";
import type { PromptContext } from "./types.ts";

/**
 * Maps consuming agent subagent_type to the handoff files it should receive.
 *
 * Each entry is a list of filenames to look up in {workspace}/handoffs/.
 * The values are the full filenames produced by write_handoff (type → filename).
 */
const HANDOFF_CONSUMER_MAP: Record<string, string[]> = {
  "canon:canon-architect": ["research-synthesis.md"],
  "canon:canon-implementor": ["design-brief.md"],
  "canon:canon-tester": ["impl-handoff.md"],
  "canon:canon-fixer": ["test-findings.md"],
};

/**
 * Stage 2: Inject handoff files as ${handoff_context}.
 *
 * Reads handoff markdown files for the current agent type from the workspace's
 * handoffs/ directory. Missing files are treated as warnings, not errors —
 * handoffs are best-effort; they may not yet exist if the prior stage did not
 * produce them.
 */
export async function injectHandoffs(ctx: PromptContext): Promise<PromptContext> {
  const agentType = ctx.state.agent;

  // No mapping for this agent type — return ctx unchanged (same reference)
  if (!agentType || !(agentType in HANDOFF_CONSUMER_MAP)) {
    return ctx;
  }

  const filenames = HANDOFF_CONSUMER_MAP[agentType];
  const newWarnings = [...ctx.warnings];
  const contents: string[] = [];

  for (const filename of filenames) {
    const filePath = resolve(join(ctx.input.workspace, "handoffs", filename));

    if (!existsSync(filePath)) {
      newWarnings.push(
        `injectHandoffs: handoff file not found — ${filename} (workspace: ${ctx.input.workspace})`,
      );
      continue;
    }

    try {
      const raw = await readFile(filePath, "utf-8");
      // Escape at the read boundary — same pattern as resolve-context.ts
      contents.push(escapeDollarBrace(raw));
    } catch (err) {
      newWarnings.push(
        `injectHandoffs: failed to read ${filename} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // No content was successfully read — return ctx with warnings but no variable
  if (contents.length === 0) {
    return {
      ...ctx,
      warnings: newWarnings,
    };
  }

  return {
    ...ctx,
    mergedVariables: {
      ...ctx.mergedVariables,
      handoff_context: contents.join("\n\n---\n\n"),
    },
    warnings: newWarnings,
  };
}
