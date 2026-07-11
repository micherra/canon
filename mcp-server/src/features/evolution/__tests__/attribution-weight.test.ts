/**
 * attribution-weight.test.ts — Pure unit tests for computeTrustWeight.
 *
 * All fixtures hold every factor but the one under test at neutral defaults
 * (distinct_owning_steps: 1, signal_age_ms: 0, outcome: {}, sign: 1, tier omitted,
 * is_adversarial_step omitted) so each assertion isolates one sub-weight.
 *
 * Tests verify:
 * (a) tier ordering: security/reviewer > engineer-author > other
 * (b) adversarial re-review step > first-pass reviewer
 * (c) corroboration monotonic non-decreasing + ceilinged
 * (d) decay monotonic decreasing, age 0 -> no attenuation, floored above 0
 * (e) sign flips the contribution
 * (f) codex slot is reserved/unused in v1 — defaults to internal
 * (g) non-finite inputs fall back to neutral, never throw
 * (h) determinism: identical input -> identical (===) output
 *
 * Canon principles:
 *   - no-llm-calls-in-mcp-tools: pure arithmetic only
 *   - errors-are-values: non-finite/absent inputs fall back to neutral, never thrown
 */

import { describe, expect, it } from "vitest";
import type { SignContribution } from "../services/attribution-weight.ts";
import { computeTrustWeight } from "../services/attribution-weight.ts";

function makeContribution(overrides?: Partial<SignContribution>): SignContribution {
  return {
    agent_name: "canon:engineer",
    distinct_owning_steps: 1,
    outcome: {},
    sign: 1,
    signal_age_ms: 0,
    ...overrides,
  };
}

describe("computeTrustWeight — role tier ordering", () => {
  it("security > engineer-author", () => {
    const security = computeTrustWeight(makeContribution({ agent_name: "canon:security" }));
    const engineer = computeTrustWeight(makeContribution({ agent_name: "canon:engineer" }));
    expect(security).toBeGreaterThan(engineer);
  });

  it("reviewer > engineer-author", () => {
    const reviewer = computeTrustWeight(makeContribution({ agent_name: "canon:reviewer" }));
    const engineer = computeTrustWeight(makeContribution({ agent_name: "canon:engineer" }));
    expect(reviewer).toBeGreaterThan(engineer);
  });

  it("engineer-author > other", () => {
    const engineer = computeTrustWeight(makeContribution({ agent_name: "canon:engineer" }));
    const other = computeTrustWeight(makeContribution({ agent_name: "canon:scribe" }));
    expect(engineer).toBeGreaterThan(other);
  });

  it("security and reviewer share the same top tier", () => {
    const security = computeTrustWeight(makeContribution({ agent_name: "canon:security" }));
    const reviewer = computeTrustWeight(makeContribution({ agent_name: "canon:reviewer" }));
    expect(security).toBe(reviewer);
  });
});

describe("computeTrustWeight — adversarial step", () => {
  it("an adversarial re-review step outweighs a first-pass reviewer", () => {
    const adversarial = computeTrustWeight(
      makeContribution({ agent_name: "canon:reviewer", is_adversarial_step: true }),
    );
    const firstPass = computeTrustWeight(
      makeContribution({ agent_name: "canon:reviewer", is_adversarial_step: false }),
    );
    expect(adversarial).toBeGreaterThan(firstPass);
  });

  it("omitted is_adversarial_step behaves the same as explicit false", () => {
    const omitted = computeTrustWeight(makeContribution({ agent_name: "canon:reviewer" }));
    const explicitFalse = computeTrustWeight(
      makeContribution({ agent_name: "canon:reviewer", is_adversarial_step: false }),
    );
    expect(omitted).toBe(explicitFalse);
  });
});

describe("computeTrustWeight — corroboration", () => {
  it("is monotonic non-decreasing in distinct_owning_steps", () => {
    const weights = [1, 2, 3, 5, 10].map((n) =>
      computeTrustWeight(makeContribution({ distinct_owning_steps: n })),
    );
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1]);
    }
  });

  it("is ceilinged — very large step counts plateau", () => {
    const large = computeTrustWeight(makeContribution({ distinct_owning_steps: 1000 }));
    const huge = computeTrustWeight(makeContribution({ distinct_owning_steps: 1_000_000 }));
    expect(huge).toBe(large);
  });
});

describe("computeTrustWeight — decay", () => {
  it("age 0 applies no attenuation relative to a large age", () => {
    const fresh = computeTrustWeight(makeContribution({ signal_age_ms: 0 }));
    const old = computeTrustWeight(makeContribution({ signal_age_ms: 30 * 24 * 60 * 60 * 1000 }));
    expect(fresh).toBeGreaterThan(old);
  });

  it("is monotonic decreasing as age increases", () => {
    const ages = [0, 1000, 60_000, 3_600_000, 86_400_000, 30 * 86_400_000];
    const weights = ages.map((age) => computeTrustWeight(makeContribution({ signal_age_ms: age })));
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThanOrEqual(weights[i - 1]);
    }
  });

  it("is floored above 0 for very old signals", () => {
    const ancient = computeTrustWeight(makeContribution({ signal_age_ms: 365 * 86_400_000 * 100 }));
    expect(ancient).toBeGreaterThan(0);
  });
});

describe("computeTrustWeight — sign", () => {
  it("flips the sign of the contribution, magnitude unchanged", () => {
    const positive = computeTrustWeight(makeContribution({ sign: 1 }));
    const negative = computeTrustWeight(makeContribution({ sign: -1 }));
    expect(negative).toBe(-positive);
  });
});

describe("computeTrustWeight — codex tier slot (v1 descoped)", () => {
  it("omitted tier defaults to internal", () => {
    const omitted = computeTrustWeight(makeContribution());
    const explicitInternal = computeTrustWeight(makeContribution({ tier: "internal" }));
    expect(omitted).toBe(explicitInternal);
  });

  it("the reserved codex slot is distinguishable from internal (open, unused in v1)", () => {
    const internal = computeTrustWeight(makeContribution({ tier: "internal" }));
    const codex = computeTrustWeight(makeContribution({ tier: "codex" }));
    expect(codex).not.toBe(internal);
  });
});

describe("computeTrustWeight — errors-are-values", () => {
  it("non-finite distinct_owning_steps and signal_age_ms fall back to neutral, never throw", () => {
    expect(() =>
      computeTrustWeight(
        makeContribution({
          distinct_owning_steps: Number.NaN,
          signal_age_ms: Number.POSITIVE_INFINITY,
        }),
      ),
    ).not.toThrow();
    const degraded = computeTrustWeight(
      makeContribution({
        distinct_owning_steps: Number.NaN,
        signal_age_ms: Number.POSITIVE_INFINITY,
      }),
    );
    const neutral = computeTrustWeight(
      makeContribution({ distinct_owning_steps: 1, signal_age_ms: 0 }),
    );
    expect(degraded).toBe(neutral);
    expect(Number.isFinite(degraded)).toBe(true);
  });

  it("negative signal_age_ms falls back to neutral (no decay), never throws", () => {
    expect(() => computeTrustWeight(makeContribution({ signal_age_ms: -1000 }))).not.toThrow();
    const negativeAge = computeTrustWeight(makeContribution({ signal_age_ms: -1000 }));
    const zeroAge = computeTrustWeight(makeContribution({ signal_age_ms: 0 }));
    expect(negativeAge).toBe(zeroAge);
  });
});

describe("computeTrustWeight — determinism", () => {
  it("identical input produces identical (===) output across calls", () => {
    const input = makeContribution({
      agent_name: "canon:security",
      distinct_owning_steps: 3,
      is_adversarial_step: true,
      outcome: { fix_iterations: 1, review_verdict: "clean", test_pass_rate: 0.9 },
      signal_age_ms: 86_400_000,
    });
    const first = computeTrustWeight(input);
    const second = computeTrustWeight(input);
    expect(first).toBe(second);
  });
});
