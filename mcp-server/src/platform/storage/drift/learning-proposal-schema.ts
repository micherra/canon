/**
 * LearningProposal Zod schema — proposal frontmatter validation
 *
 * Defines the canonical shape of a learning proposal as specified in
 * canon-learner.md Step 5. Used by server-side validators (e.g. learn-gate.ts)
 * to detect malformed proposals before they reach the user.
 *
 * Security note: consumers must validate file paths with `isPathContained`
 * before reading proposal file content — this schema validates structure only.
 *
 * Use safeParse at all validation boundaries so malformed proposals produce
 * structured errors rather than silently failing (no-silent-failures).
 */

import { z } from "zod";

export const LearningProposalSchema = z.object({
  proposal_id: z.string(),
  type: z.enum([
    "new-convention",
    "severity-change",
    "principle-revision",
    "convention-graduation",
    "stale-removal",
  ]),
  confidence: z.number().min(0).max(1),
  target: z.string(),
});

export type LearningProposal = z.infer<typeof LearningProposalSchema>;
