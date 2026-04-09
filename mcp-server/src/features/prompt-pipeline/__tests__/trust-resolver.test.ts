/**
 * Tests for trust-resolver.ts — pure TrustResolver module
 *
 * Covers:
 * - computeTrustLevel: all trust levels (HIGH, MEDIUM, LOW, BLOCKED)
 * - computeTrustLevel: all degradation paths (no KG, stale KG, no-write agent, empty scope)
 * - trustLevelToPermissionMode: mapping for all levels
 * - trustLevelToPermissionMode: never returns "deny_unknown"
 * - buildScopeMetrics: aggregation of hub/degree/cycle flags
 * - buildScopeMetrics: null entries treated as low-risk
 * - canon-scribe: Edit counts as write capability
 */

import { describe, expect, it } from "vitest";
import {
  buildScopeMetrics,
  computeTrustLevel,
  trustLevelToPermissionMode,
} from "../services/trust-resolver.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLowRiskInput() {
  return {
    agent: "canon-implementor",
    agentCanWrite: true,
    kgFreshnessMs: 60_000, // 1 minute — fresh
    scopeMetrics: {
      hasCycleFile: false,
      hasHighDegreeFile: false,
      hasHubFile: false,
    },
    taskScope: ["src/foo.ts", "src/bar.ts"],
  };
}

// ---------------------------------------------------------------------------
// computeTrustLevel — happy path: HIGH
// ---------------------------------------------------------------------------

describe("computeTrustLevel — HIGH", () => {
  it("returns HIGH when all signals present and scope files are low-risk", () => {
    const result = computeTrustLevel(makeLowRiskInput());
    expect(result.level).toBe("HIGH");
    expect(result.reason).toContain("low-risk");
  });
});

// ---------------------------------------------------------------------------
// computeTrustLevel — MEDIUM
// ---------------------------------------------------------------------------

describe("computeTrustLevel — MEDIUM", () => {
  it("returns MEDIUM when scope has a hub file", () => {
    const result = computeTrustLevel({
      ...makeLowRiskInput(),
      scopeMetrics: {
        hasCycleFile: false,
        hasHighDegreeFile: false,
        hasHubFile: true,
      },
    });
    expect(result.level).toBe("MEDIUM");
    expect(result.reason).toContain("hub");
  });

  it("returns MEDIUM when scope has a high-degree file (inDegree > 8 after aggregation)", () => {
    const result = computeTrustLevel({
      ...makeLowRiskInput(),
      scopeMetrics: {
        hasCycleFile: false,
        hasHighDegreeFile: true,
        hasHubFile: false,
      },
    });
    expect(result.level).toBe("MEDIUM");
    expect(result.reason).toContain("high-degree");
  });

  it("returns MEDIUM when scope has both hub and high-degree files", () => {
    const result = computeTrustLevel({
      ...makeLowRiskInput(),
      scopeMetrics: {
        hasCycleFile: false,
        hasHighDegreeFile: true,
        hasHubFile: true,
      },
    });
    expect(result.level).toBe("MEDIUM");
  });
});

// ---------------------------------------------------------------------------
// computeTrustLevel — LOW degradation paths
// ---------------------------------------------------------------------------

describe("computeTrustLevel — LOW degradation", () => {
  it("returns LOW when kgFreshnessMs is null (KG not available)", () => {
    const result = computeTrustLevel({
      ...makeLowRiskInput(),
      kgFreshnessMs: null,
    });
    expect(result.level).toBe("LOW");
    expect(result.reason).toContain("KG not available");
  });

  it("returns LOW when KG is stale (> 1 hour)", () => {
    const result = computeTrustLevel({
      ...makeLowRiskInput(),
      kgFreshnessMs: 3_600_001, // 1ms over 1 hour
    });
    expect(result.level).toBe("LOW");
    expect(result.reason).toContain("stale");
  });

  it("returns LOW when KG freshness is exactly at the staleness boundary (3_600_000ms) — NOT stale", () => {
    // Exactly 1 hour — should NOT be stale (boundary is strictly >)
    const result = computeTrustLevel({
      ...makeLowRiskInput(),
      kgFreshnessMs: 3_600_000,
    });
    // At exactly 1hr, kgFreshnessMs > KG_STALENESS_MS is false (equal, not greater)
    // so this should proceed to the write-capability check — HIGH for this input
    expect(result.level).toBe("HIGH");
  });

  it("returns LOW when task scope is empty", () => {
    const result = computeTrustLevel({
      ...makeLowRiskInput(),
      taskScope: [],
    });
    expect(result.level).toBe("LOW");
    expect(result.reason).toContain("Empty task scope");
  });
});

// ---------------------------------------------------------------------------
// computeTrustLevel — BLOCKED
// ---------------------------------------------------------------------------

describe("computeTrustLevel — BLOCKED", () => {
  it("returns BLOCKED when agent cannot write", () => {
    const result = computeTrustLevel({
      ...makeLowRiskInput(),
      agentCanWrite: false,
    });
    expect(result.level).toBe("BLOCKED");
    expect(result.reason).toContain("no write capability");
  });

  it("includes agent name in BLOCKED reason", () => {
    const result = computeTrustLevel({
      ...makeLowRiskInput(),
      agent: "canon-researcher",
      agentCanWrite: false,
    });
    expect(result.level).toBe("BLOCKED");
    expect(result.reason).toContain("canon-researcher");
  });

  it("BLOCKED check is gated after KG checks — stale KG returns LOW not BLOCKED", () => {
    // KG staleness is checked first; BLOCKED gate comes after
    const result = computeTrustLevel({
      ...makeLowRiskInput(),
      agentCanWrite: false,
      kgFreshnessMs: 9_999_999, // stale
    });
    // Gate 2 (stale) fires before gate 3 (no write) — must return LOW
    expect(result.level).toBe("LOW");
  });
});

// ---------------------------------------------------------------------------
// trustLevelToPermissionMode
// ---------------------------------------------------------------------------

describe("trustLevelToPermissionMode", () => {
  it("maps HIGH to 'auto'", () => {
    expect(trustLevelToPermissionMode("HIGH")).toBe("auto");
  });

  it("maps MEDIUM to 'auto'", () => {
    expect(trustLevelToPermissionMode("MEDIUM")).toBe("auto");
  });

  it("maps LOW to 'prompt'", () => {
    expect(trustLevelToPermissionMode("LOW")).toBe("prompt");
  });

  it("maps BLOCKED to 'prompt'", () => {
    expect(trustLevelToPermissionMode("BLOCKED")).toBe("prompt");
  });

  it("never returns 'deny_unknown' for any trust level", () => {
    const levels = ["HIGH", "MEDIUM", "LOW", "BLOCKED"] as const;
    for (const level of levels) {
      const mode = trustLevelToPermissionMode(level);
      expect(mode).not.toBe("deny_unknown");
    }
  });
});

// ---------------------------------------------------------------------------
// buildScopeMetrics
// ---------------------------------------------------------------------------

describe("buildScopeMetrics", () => {
  it("returns all false for empty file list", () => {
    const result = buildScopeMetrics([]);
    expect(result).toEqual({
      hasCycleFile: false,
      hasHighDegreeFile: false,
      hasHubFile: false,
    });
  });

  it("detects hasHubFile when any file is a hub", () => {
    const result = buildScopeMetrics([
      { inCycle: false, inDegree: 2, isHub: false },
      { inCycle: false, inDegree: 3, isHub: true },
    ]);
    expect(result.hasHubFile).toBe(true);
    expect(result.hasHighDegreeFile).toBe(false);
    expect(result.hasCycleFile).toBe(false);
  });

  it("detects hasHighDegreeFile when inDegree > 8 (HIGH_DEGREE_THRESHOLD)", () => {
    const result = buildScopeMetrics([{ inCycle: false, inDegree: 9, isHub: false }]);
    expect(result.hasHighDegreeFile).toBe(true);
    expect(result.hasHubFile).toBe(false);
  });

  it("does NOT set hasHighDegreeFile when inDegree is exactly 8 (threshold is > 8, not >= 8)", () => {
    const result = buildScopeMetrics([{ inCycle: false, inDegree: 8, isHub: false }]);
    expect(result.hasHighDegreeFile).toBe(false);
  });

  it("detects hasCycleFile when any file is in a cycle", () => {
    const result = buildScopeMetrics([
      { inCycle: true, inDegree: 1, isHub: false },
      { inCycle: false, inDegree: 2, isHub: false },
    ]);
    expect(result.hasCycleFile).toBe(true);
  });

  it("treats null entries as low-risk (unindexed files)", () => {
    const result = buildScopeMetrics([null, null, { inCycle: false, inDegree: 1, isHub: false }]);
    expect(result.hasHubFile).toBe(false);
    expect(result.hasHighDegreeFile).toBe(false);
    expect(result.hasCycleFile).toBe(false);
  });

  it("handles mixed null and real entries — real entries' flags are still detected", () => {
    const result = buildScopeMetrics([null, { inCycle: false, inDegree: 2, isHub: true }]);
    expect(result.hasHubFile).toBe(true);
  });

  it("aggregates all-null list to all-false (unindexed scope is low-risk)", () => {
    const result = buildScopeMetrics([null, null, null]);
    expect(result).toEqual({
      hasCycleFile: false,
      hasHighDegreeFile: false,
      hasHubFile: false,
    });
  });
});

// ---------------------------------------------------------------------------
// canon-scribe: Edit counts as write capability (not blocked)
// ---------------------------------------------------------------------------

describe("canon-scribe: Edit capability counts as write", () => {
  it("when agentCanWrite is true (caller resolved Edit as write capability), trust computation proceeds past BLOCKED gate", () => {
    // canon-scribe has Edit in its profile but NOT Write.
    // The caller (inject-coordination.ts) is responsible for resolving
    // agentCanWrite based on whether Edit or Write appears in the agent's profile.
    // Here we verify that agentCanWrite: true with a low-risk scope yields HIGH,
    // confirming that the trust function correctly uses the caller-provided flag.
    const result = computeTrustLevel({
      agent: "canon-scribe",
      agentCanWrite: true, // Edit counts as write capability per plan spec
      kgFreshnessMs: 60_000,
      scopeMetrics: {
        hasCycleFile: false,
        hasHighDegreeFile: false,
        hasHubFile: false,
      },
      taskScope: ["src/doc.md"],
    });
    // Should not be BLOCKED since agentCanWrite is true
    expect(result.level).not.toBe("BLOCKED");
    expect(result.level).toBe("HIGH");
  });

  it("when agentCanWrite is false (unknown agent resolved to EMPTY_PROFILE), returns BLOCKED", () => {
    // EMPTY_PROFILE has no Edit or Write — agentCanWrite resolves to false
    const result = computeTrustLevel({
      agent: "unknown-agent",
      agentCanWrite: false,
      kgFreshnessMs: 60_000,
      scopeMetrics: {
        hasCycleFile: false,
        hasHighDegreeFile: false,
        hasHubFile: false,
      },
      taskScope: ["src/foo.ts"],
    });
    expect(result.level).toBe("BLOCKED");
  });
});
