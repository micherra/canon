/**
 * Shared handoff type definitions used by both the producer (report-result.ts)
 * and consumer (inject-handoffs.ts) sides of the handoff pipeline.
 *
 * Centralizing these maps prevents the two from drifting out of sync.
 */

/** Maps producer agent type to the handoff file they should write. */
export const HANDOFF_PRODUCER_MAP: Record<string, string> = {
  "canon:canon-researcher": "research-synthesis.md",
  "canon:canon-architect": "design-brief.md",
  "canon:canon-implementor": "impl-handoff.md",
  "canon:canon-tester": "test-findings.md",
};

/** Maps consuming agent type to the handoff files it should receive. */
export const HANDOFF_CONSUMER_MAP: Record<string, string[]> = {
  "canon:canon-architect": ["research-synthesis.md"],
  "canon:canon-implementor": ["design-brief.md"],
  "canon:canon-tester": ["impl-handoff.md"],
  "canon:canon-fixer": ["test-findings.md"],
};
