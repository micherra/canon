/**
 * Debate protocol — multi-round structured conversations between competing teams.
 *
 * Built on the unified messaging system. The debate is a sequence of rounds
 * where teams publish positions, challenge each other, and converge (or don't).
 * The orchestrator drives round sequencing; this module provides framing,
 * convergence detection, and summary building.
 */

import { readChannelAsContext, readMessages, type Message } from "./messages.ts";
import { getExecutionStore } from "./execution-store.ts";

export interface DebateConfig {
  /** Number of competing teams (default 3) */
  teams: number;
  /** Agent types composing each team (e.g. ["canon-researcher", "canon-architect"]) */
  composition: string[];
  /** Minimum rounds before convergence check (default 2) */
  min_rounds: number;
  /** Hard cap on rounds (default 5) */
  max_rounds: number;
  /** Start convergence checking after this round (default 3) */
  convergence_check_after: number;
  /** Pause for user review before proceeding (default true) */
  hitl_checkpoint: boolean;
  /** Winning teams continue into implementation (default true) */
  continue_to_build: boolean;
}

export type RoundType = "position" | "challenge" | "response" | "narrow";

export interface DebateRound {
  number: number;
  type: RoundType;
  teamMessages: Record<string, string[]>; // team-id → message file paths
}

export interface ConvergenceResult {
  converged: boolean;
  reason?: string;
}

export interface DebateProgress {
  completed: boolean;
  next_round: number;
  last_completed_round: number;
  next_channel: string;
  transcript?: string;
  summary?: string;
  convergence?: ConvergenceResult;
}

const TEAM_LABELS = ["Team A", "Team B", "Team C", "Team D", "Team E"];

export function debateChannel(roundNumber: number): string {
  return `debate-round-${roundNumber}`;
}

export function debateTeamLabel(index: number): string {
  return TEAM_LABELS[index] ?? `Team ${index + 1}`;
}

function debateSender(roundNumber: number, teamLabel: string, agent: string): string {
  const teamSlug = teamLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const agentSlug = agent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `round-${roundNumber}-${teamSlug}-${agentSlug}`;
}

export async function inspectDebateProgress(
  workspace: string,
  config: DebateConfig,
): Promise<DebateProgress> {
  // Discover populated debate-round-N channels from the SQLite messages table
  let roundNumbers: number[] = [];

  try {
    const store = getExecutionStore(workspace);
    // Probe each possible round channel up to max_rounds to find populated ones
    for (let r = 1; r <= config.max_rounds; r++) {
      const channel = debateChannel(r);
      const msgs = store.getMessages(channel);
      if (msgs.length > 0) {
        roundNumbers.push(r);
      }
    }
  } catch {
    roundNumbers = [];
  }

  const populatedRounds: number[] = [];
  const transcriptSections: string[] = [];
  for (const round of roundNumbers) {
    const channel = debateChannel(round);
    const messages = await readMessages(workspace, channel);
    if (messages.length === 0) continue;
    populatedRounds.push(round);

    const context = await readChannelAsContext(workspace, channel, { maxChars: 3000 });
    if (context) {
      transcriptSections.push(`### Debate Round ${round}\n\n${context}`);
    }
  }

  const lastCompletedRound = populatedRounds.at(-1) ?? 0;
  const nextRound = lastCompletedRound === 0 ? 1 : Math.min(lastCompletedRound + 1, config.max_rounds);

  let convergence: ConvergenceResult | undefined;
  if (lastCompletedRound >= Math.max(config.min_rounds, config.convergence_check_after)) {
    const latestMessages = await readMessages(workspace, debateChannel(lastCompletedRound));
    convergence = heuristicConvergence(latestMessages);
  }

  const completed = Boolean(convergence?.converged) || lastCompletedRound >= config.max_rounds;
  const summary = transcriptSections.length > 0
    ? `## Debate Transcript Summary\n\n${transcriptSections.join("\n\n")}`
    : undefined;

  return {
    completed,
    next_round: completed ? lastCompletedRound : nextRound,
    last_completed_round: lastCompletedRound,
    next_channel: debateChannel(completed ? lastCompletedRound : nextRound),
    ...(transcriptSections.length > 0 ? { transcript: transcriptSections.join("\n\n") } : {}),
    ...(summary ? { summary } : {}),
    ...(convergence ? { convergence } : {}),
  };
}

/**
 * Determine the round type based on round number.
 *
 * Round 1: position — each team states their approach
 * Round 2: challenge — each team critiques the others
 * Round 3: response — teams defend/revise based on challenges
 * Round 4+: narrow — focus only on remaining disagreements
 */
export function roundType(roundNumber: number): RoundType {
  switch (roundNumber) {
    case 1: return "position";
    case 2: return "challenge";
    case 3: return "response";
    default: return "narrow";
  }
}

/**
 * Build the framing instructions for a team's agent in a given round.
 *
 * The framing tells the agent what kind of message to produce based on
 * the round type. This is injected into the agent's spawn prompt alongside
 * the conversation history.
 */
export function roundFraming(
  roundNumber: number,
  maxRounds: number,
  teamLabel: string,
  otherTeamLabels: string[],
): string {
  const type = roundType(roundNumber);
  const others = otherTeamLabels.join(" and ");

  switch (type) {
    case "position":
      return `## Debate Round ${roundNumber}: State Your Position

You are **${teamLabel}**. Present your approach to the problem.

Be specific and concrete. Explain your core idea, the key tradeoffs you're making, and why you believe this direction is strongest. This is your opening argument — make it compelling.`;

    case "challenge":
      return `## Debate Round ${roundNumber}: Challenge Other Positions

You are **${teamLabel}**. You've read the positions from ${others}.

Your job is to find weaknesses, gaps, and risks in their approaches. Ask pointed questions. Identify assumptions they haven't justified. Point out edge cases they haven't considered.

Be rigorous but fair. If another team's idea is genuinely strong in some area, acknowledge it — but focus on the weaknesses.`;

    case "response":
      return `## Debate Round ${roundNumber}: Respond to Challenges

You are **${teamLabel}**. You've received challenges from ${others}.

Address each challenge directly:
- If the challenge is valid, revise your position and explain the adjustment
- If the challenge is misguided, defend your position with specific reasoning
- If the challenge reveals a genuine tradeoff, acknowledge it and explain why your direction is still preferable

Be honest about what you've changed and what you're holding firm on.`;

    case "narrow":
      return `## Debate Round ${roundNumber}: Focus on Remaining Disagreements

You are **${teamLabel}**. This is round ${roundNumber} of ${maxRounds}.

Focus ONLY on unresolved disagreements. Do not re-litigate settled points. If you and another team now agree on something, say so briefly and move on.

If you believe the debate has converged and there's nothing meaningful left to discuss, say so explicitly.`;
  }
}

/**
 * Build a debate summary from all messages in the debate channel.
 *
 * The summary is structured for HITL review: it shows the trajectory of
 * the debate, what converged, and what remains unresolved.
 */
export async function buildDebateSummary(
  workspace: string,
  channel: string,
): Promise<string> {
  const messages = await readMessages(workspace, channel);
  if (messages.length === 0) return "No debate messages found.";

  // Group messages by round (parsed from filename prefix pattern: round-N-)
  const rounds = new Map<number, Message[]>();
  for (const msg of messages) {
    const roundMatch = msg.from.match(/round-(\d+)/i);
    const roundNum = roundMatch ? parseInt(roundMatch[1], 10) : 0;
    if (!rounds.has(roundNum)) rounds.set(roundNum, []);
    rounds.get(roundNum)!.push(msg);
  }

  const sections: string[] = ["## Debate Summary\n"];

  const sortedRounds = [...rounds.keys()].sort((a, b) => a - b);
  for (const roundNum of sortedRounds) {
    const roundMessages = rounds.get(roundNum)!;
    const type = roundNum > 0 ? roundType(roundNum) : "pre-debate";
    sections.push(`### Round ${roundNum} (${type})\n`);
    for (const msg of roundMessages) {
      // Truncate each message to first ~200 chars for the summary
      const preview = msg.content.length > 200
        ? msg.content.slice(0, 200).trimEnd() + "..."
        : msg.content;
      sections.push(`**${msg.from}:** ${preview}\n`);
    }
  }

  return sections.join("\n");
}

/**
 * Heuristic convergence check: analyze the latest round's messages to
 * detect whether the debate has stabilized.
 *
 * Signals:
 * - Messages contain convergence language ("agree", "converged", "same conclusion")
 * - Messages are short (teams have nothing new to add)
 * - Teams explicitly state they've reached consensus
 *
 * This is a cheap heuristic. For more reliable detection, the orchestrator
 * should spawn a lightweight agent to read the full transcript.
 */
/** Negation words that, when appearing within a few words before a convergence term, cancel it. */
const NEGATION_WORDS = ["don't", "dont", "doesn't", "doesnt", "not", "no", "never", "can't", "cant", "won't", "wont"];

/**
 * Check whether a convergence term occurrence at the given index in the lowercased text
 * is preceded by a negation word within a window of ~5 words.
 */
function isNegated(text: string, termIndex: number): boolean {
  // Look at the 50 characters before the term to catch "don't agree", "not aligned", etc.
  const window = text.slice(Math.max(0, termIndex - 50), termIndex);
  for (const negation of NEGATION_WORDS) {
    // Check that the negation word appears as a whole-word match in the window
    const negRegex = new RegExp(`\\b${negation}\\b`, "i");
    if (negRegex.test(window)) {
      return true;
    }
  }
  return false;
}

export function heuristicConvergence(roundMessages: Message[]): ConvergenceResult {
  const convergenceTerms = [
    "agree", "converged", "consensus", "same conclusion",
    "nothing left to discuss", "no remaining disagreement",
    "aligned", "on the same page",
  ];

  let convergenceSignals = 0;
  let totalLength = 0;

  for (const msg of roundMessages) {
    const lower = msg.content.toLowerCase();
    totalLength += msg.content.length;

    for (const term of convergenceTerms) {
      const idx = lower.indexOf(term);
      if (idx !== -1 && !isNegated(lower, idx)) {
        convergenceSignals++;
        break; // one signal per message is enough
      }
    }
  }

  // If majority of messages contain convergence language
  if (roundMessages.length > 0 && convergenceSignals >= Math.ceil(roundMessages.length * 0.66)) {
    return { converged: true, reason: "Majority of teams signaling agreement" };
  }

  // If messages are very short (teams have nothing substantive to add)
  const avgLength = totalLength / Math.max(roundMessages.length, 1);
  if (roundMessages.length > 0 && avgLength < 100) {
    return { converged: true, reason: "Messages are very brief — debate appears exhausted" };
  }

  return { converged: false };
}

export function buildDebatePrompt(
  basePrompt: string,
  workspace: string,
  roundNumber: number,
  maxRounds: number,
  teamLabel: string,
  otherTeamLabels: string[],
  agent: string,
  transcript?: string,
): string {
  const channel = debateChannel(roundNumber);
  const sender = debateSender(roundNumber, teamLabel, agent);
  const transcriptSection = transcript
    ? `\n\n## Prior Debate Transcript\n\n${transcript}`
    : "";

  return `${basePrompt}${transcriptSection}\n\n${roundFraming(roundNumber, maxRounds, teamLabel, otherTeamLabels)}\n\n## Debate Coordination\nUse the debate transcript above as your current context.\n\nWhen you finish your contribution, post it with:\npost_message(workspace="${workspace}", channel="${channel}", from="${sender}", content="...")`;
}
