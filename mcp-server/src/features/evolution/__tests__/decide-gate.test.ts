/**
 * decide-gate.test.ts — §7 evolution hard gate
 *
 * The four canonical cases:
 * (a) holdout up → accepted=true
 * (b) holdout unchanged → accepted=false
 * (c) holdout regress → accepted=false, regressed=true
 * (d) train up + holdout unchanged ("behavioral-only") → accepted=false
 *
 * Plus invariant: changing train/val numbers with holdout fixed never flips accepted.
 */

import { describe, expect, it } from "vitest";
import type { PerSplit } from "../services/eval-runner.ts";
import { decideGate } from "../services/eval-runner.ts";

type MakePerSplitOpts = {
  holdoutBaseline: number;
  holdoutCandidate: number;
  trainBaseline?: number;
  trainCandidate?: number;
  valBaseline?: number;
  valCandidate?: number;
  total?: number;
};

function makePerSplit(opts: MakePerSplitOpts): PerSplit {
  const {
    holdoutBaseline,
    holdoutCandidate,
    total = 18,
    trainBaseline = 5,
    trainCandidate = 5,
    valBaseline = 2,
    valCandidate = 2,
  } = opts;
  return {
    holdout: {
      baseline_passed: holdoutBaseline,
      candidate_passed: holdoutCandidate,
      total,
    },
    train: {
      baseline_passed: trainBaseline,
      candidate_passed: trainCandidate,
      total: 13,
    },
    val: {
      baseline_passed: valBaseline,
      candidate_passed: valCandidate,
      total: 2,
    },
  };
}

describe("decideGate — §7 hard gate", () => {
  it("(a) holdout up → accepted=true, regressed=false", () => {
    const result = decideGate(makePerSplit({ holdoutBaseline: 2, holdoutCandidate: 3 }));
    expect(result).toEqual({ accepted: true, regressed: false });
  });

  it("(b) holdout unchanged → accepted=false, regressed=false", () => {
    const result = decideGate(makePerSplit({ holdoutBaseline: 2, holdoutCandidate: 2 }));
    expect(result).toEqual({ accepted: false, regressed: false });
  });

  it("(c) holdout regress → accepted=false, regressed=true", () => {
    const result = decideGate(makePerSplit({ holdoutBaseline: 3, holdoutCandidate: 2 }));
    expect(result).toEqual({ accepted: false, regressed: true });
  });

  it("(d) train up + holdout unchanged → accepted=false (behavioral-only, never accepted)", () => {
    // Train improves from 5→13, holdout stays 2→2
    const result = decideGate(
      makePerSplit({
        holdoutBaseline: 2,
        holdoutCandidate: 2,
        trainBaseline: 5,
        trainCandidate: 13,
      }),
    );
    expect(result).toEqual({ accepted: false, regressed: false });
  });

  it("invariant: changing train with holdout fixed never flips accepted", () => {
    // Try every combination of train improvement
    for (let trainBase = 0; trainBase <= 13; trainBase++) {
      for (let trainCand = 0; trainCand <= 13; trainCand++) {
        const result = decideGate(
          makePerSplit({
            holdoutBaseline: 2,
            holdoutCandidate: 2,
            trainBaseline: trainBase,
            trainCandidate: trainCand,
          }),
        );
        expect(result.accepted).toBe(false); // holdout == holdout → never accepted
      }
    }
  });

  it("invariant: changing val with holdout fixed never flips accepted", () => {
    for (let valBase = 0; valBase <= 2; valBase++) {
      for (let valCand = 0; valCand <= 2; valCand++) {
        const result = decideGate(
          makePerSplit({
            holdoutBaseline: 2,
            holdoutCandidate: 2,
            valBaseline: valBase,
            valCandidate: valCand,
          }),
        );
        expect(result.accepted).toBe(false);
      }
    }
  });

  it("edge: holdout zero baseline → candidate 1 passes (any improvement counts)", () => {
    const result = decideGate(makePerSplit({ holdoutBaseline: 0, holdoutCandidate: 1 }));
    expect(result).toEqual({ accepted: true, regressed: false });
  });

  it("edge: holdout 0→0 (all zeros) → reject, not regressed", () => {
    const result = decideGate(makePerSplit({ holdoutBaseline: 0, holdoutCandidate: 0 }));
    expect(result).toEqual({ accepted: false, regressed: false });
  });
});
