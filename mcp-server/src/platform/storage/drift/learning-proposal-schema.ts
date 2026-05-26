/**
 * LearningProposal Zod schema — proposal frontmatter validation
 *
 * Defines the canonical shape of a learning proposal as specified in
 * learner.md Step 5. Used by server-side validators (e.g. learn-gate.ts)
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
  confidence: z.number().min(0).max(1),
  confidence_annotation: z
    .object({
      basis: z.array(
        z.object({
          detail: z.string(),
          signal: z.string(),
          weight: z.number().min(0).max(1),
        }),
      ),
      sample_size: z.number().int().min(0),
      score: z.number().min(0).max(1),
      tier: z.enum(["high", "medium", "low", "insufficient"]),
    })
    .optional(),
  proposal_id: z.string(),
  target: z.string(),
  type: z.enum([
    "new-convention",
    "severity-change",
    "principle-revision",
    "convention-graduation",
    "stale-removal",
  ]),
});

export type LearningProposal = z.infer<typeof LearningProposalSchema>;
