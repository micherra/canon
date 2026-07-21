/**
 * finalize-helpers-t2.test.ts — unit tests for computeT2NonFiring, the
 * ADR-0065 observability sibling of computeGateNonEvaluations. Pure
 * function over JournalStep[]; no I/O.
 */

import { describe, expect, it } from "vitest";
import type { JournalStep } from "../../tools/orchestration-journal.ts";
import { computeT2NonFiring } from "../finalize-helpers.ts";

function reviewStep(overrides: Partial<JournalStep> = {}): JournalStep {
  return {
    agent_type: "reviewer",
    artifacts_expected: [],
    status: "completed",
    step_id: "review",
    ...overrides,
  };
}

describe("computeT2NonFiring", () => {
  it("returns one entry for a completed review step whose outcome lacks t2_recorded:true", () => {
    const steps: JournalStep[] = [reviewStep({ outcome: {} })];
    expect(computeT2NonFiring(steps)).toEqual([{ step_id: "review" }]);
  });

  it("returns empty when the review step's outcome has t2_recorded:true", () => {
    const steps: JournalStep[] = [reviewStep({ outcome: { t2_recorded: true } })];
    expect(computeT2NonFiring(steps)).toEqual([]);
  });

  it("returns one entry when outcome is entirely absent", () => {
    const steps: JournalStep[] = [reviewStep()];
    expect(computeT2NonFiring(steps)).toEqual([{ step_id: "review" }]);
  });

  it("treats t2_recorded:false the same as absent", () => {
    const steps: JournalStep[] = [reviewStep({ outcome: { t2_recorded: false } })];
    expect(computeT2NonFiring(steps)).toEqual([{ step_id: "review" }]);
  });

  it("ignores non-review steps", () => {
    const steps: JournalStep[] = [
      {
        agent_type: "engineer",
        artifacts_expected: [],
        status: "completed",
        step_id: "implement",
      },
    ];
    expect(computeT2NonFiring(steps)).toEqual([]);
  });

  it("ignores review steps that are not completed", () => {
    const steps: JournalStep[] = [reviewStep({ status: "started" })];
    expect(computeT2NonFiring(steps)).toEqual([]);
  });

  it("matches a step_id of 'review' even when agent_type differs (jury-consolidation shape)", () => {
    const steps: JournalStep[] = [reviewStep({ agent_type: null, step_id: "review" })];
    expect(computeT2NonFiring(steps)).toEqual([{ step_id: "review" }]);
  });

  it("handles multiple review steps independently", () => {
    const steps: JournalStep[] = [
      reviewStep({ outcome: { t2_recorded: true }, step_id: "review" }),
      reviewStep({ agent_type: "reviewer", outcome: {}, step_id: "eval-fix-1-review" }),
    ];
    expect(computeT2NonFiring(steps)).toEqual([{ step_id: "eval-fix-1-review" }]);
  });
});
