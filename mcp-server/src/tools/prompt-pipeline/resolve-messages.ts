/**
 * Stage 3 — Resolve channel messages (inject_messages opt-in).
 *
 * When state.inject_messages is true, reads messages from the channel
 * named after the current state_id and sets ctx.mergedVariables.messages.
 * Calls escapeDollarBrace at the read boundary to prevent unintended
 * variable expansion.
 *
 * Returns ctx unchanged when inject_messages is not true, or when the
 * channel has no messages.
 */

import { readChannelAsContext } from "../../orchestration/messages.ts";
import { escapeDollarBrace } from "../../orchestration/wave-variables.ts";
import type { PromptContext } from "./types.ts";

/**
 * Stage 3: Resolve ${messages} from channel context.
 *
 * Opt-in: only runs when state.inject_messages === true.
 * Channel name = state_id (convention: agents post to a channel named after their state).
 *
 * If the channel has messages, escapes content at the read boundary and
 * sets mergedVariables.messages. If the channel is empty, returns ctx
 * unchanged (messages variable remains absent — an unresolved ${messages}
 * in the prompt will be flagged by the validate stage as an ERROR).
 */
export async function resolveMessages(ctx: PromptContext): Promise<PromptContext> {
  const { state, input } = ctx;

  // Opt-in only — return unchanged if inject_messages is not true
  if (state.inject_messages !== true) {
    return ctx;
  }

  const stateId = input.state_id;
  const content = await readChannelAsContext(input.workspace, stateId);

  // If channel has no messages, return ctx unchanged (do not set messages variable)
  if (!content) {
    return ctx;
  }

  // Escape ${...} patterns at the read boundary — external text entering the pipeline
  const escaped = escapeDollarBrace(content);

  return {
    ...ctx,
    mergedVariables: {
      ...ctx.mergedVariables,
      messages: escaped,
    },
  };
}
