/**
 * Stage 8: inject-coordination
 *
 * Applies three types of coordination injection to fanned-out prompts:
 *
 * 1. **Role substitution** (single states only): when ctx.role is set,
 *    substitutes `${role}` in all prompt entries and sets entry.role.
 *
 * 2. **Messaging instructions** (wave/parallel-per with wave set): injects
 *    wave coordination instructions so agents can communicate via post_message
 *    / get_messages.
 *
 * 3. **Metrics footer** (all prompts, unconditional): appends the
 *    record_agent_metrics instruction with concrete workspace and state_id
 *    values. Every prompt entry receives this footer regardless of state type.
 *
 * Canon: functions-do-one-thing — three related but distinct injection
 * operations, all concerning coordination and observability metadata.
 */

import { buildMessageInstructions } from "../../orchestration/messages.ts";
import { substituteVariables } from "../../orchestration/variables.ts";
import type { PromptContext } from "./types.ts";

/**
 * Build the metrics footer to append to every prompt entry.
 * Contains a concrete record_agent_metrics invocation example with the
 * real workspace and state_id so agents receive a runnable example.
 */
function buildMetricsFooter(workspace: string, stateId: string): string {
  return `## Performance Metrics

Before returning your final status, call the \`record_agent_metrics\` tool to record your session counters:

record_agent_metrics({
  workspace: ${JSON.stringify(workspace)},
  state_id: ${JSON.stringify(stateId)},
  tool_calls: <total tool invocations you made>,
  orientation_calls: <Read/Glob/Grep calls made for orientation before writing>,
  turns: <number of assistant turns in your conversation>
})

- Count every tool invocation (Read, Write, Edit, Bash, Glob, Grep, etc.) toward tool_calls
- Count Read/Glob/Grep calls made before your first Write/Edit/Bash-write toward orientation_calls
- Count each assistant response as one turn
- If you cannot count accurately, omit that field — partial data is better than wrong data
- If the tool call fails, continue with your work — metrics are best-effort`;
}

/**
 * Stage 8: Inject role substitution, messaging instructions, and metrics footer.
 */
export async function injectCoordination(ctx: PromptContext): Promise<PromptContext> {
  const { state } = ctx;
  const { state_id, workspace, wave, peer_count, role } = ctx.input;
  let prompts = [...ctx.prompts];

  // 1. Role substitution for single-role states
  if (role && state.type === "single") {
    prompts = prompts.map((entry) => ({
      ...entry,
      prompt: substituteVariables(entry.prompt, { role }),
      role,
    }));
  }

  // 2. Inject messaging coordination instructions for wave/parallel-per states
  if ((state.type === "wave" || state.type === "parallel-per") && wave != null) {
    const peerCount = peer_count ?? prompts.length - 1;
    const channel = `wave-${String(wave).padStart(3, "0")}`;
    const messageInstr = buildMessageInstructions(channel, peerCount, workspace);
    prompts = prompts.map((entry) => ({
      ...entry,
      prompt: `${entry.prompt}\n\n${messageInstr}`,
    }));
  }

  // 3. Append metrics instruction footer to all prompts (unconditional)
  const metricsFooter = buildMetricsFooter(workspace, state_id);
  prompts = prompts.map((entry) => ({
    ...entry,
    prompt: `${entry.prompt}\n\n${metricsFooter}`,
  }));

  return { ...ctx, prompts };
}
