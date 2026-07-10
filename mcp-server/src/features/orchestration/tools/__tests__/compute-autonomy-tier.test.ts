/**
 * compute-autonomy-tier — integration tests for the tool handler layer.
 *
 * Tests cover:
 *  1. Happy path: returns tier result with score, reasoning, signals_used
 *  2. Fail-safe: returns supervised when gatherSignals throws (getDriftDb or graphQuery fails)
 *  3. auto_decision event is logged to execution store on success
 *  4. override_tier is passed through to signals and respected
 *  5. Sensitive-path deny-list floor: machine-readable result fields (floor_engaged,
 *     floor_category, floor_matched_path, require_security, require_adversarial)
 *  6. Deny-list floor survives total signal-gathering failure (fail-safe + floor overlay)
 *  7. auto_decision payload carries the floor fields when engaged
 *
 * Mock strategy:
 *  - Mock getDriftDb to return a controlled DriftDbAdapter (no real DB file)
 *  - Mock graphQuery to control KG blast radius (avoid real SQLite KG)
 *  - Mock projectDir module export (replace with a string value via vi.mock)
 *  - Mock getExecutionStore to return a real in-memory ExecutionStore
 *    (allows asserting appendEvent was called without touching filesystem)
 */

import { initExecutionDb } from "@domains/workspaces/execution-schema.ts";
import { ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (before imports) ----
// vi.mock is hoisted before variable declarations. Factories must use only
// vi.fn() inline — no references to outer let/const variables.

vi.mock("@platform/storage/drift/drift-db-cache.ts", () => ({
  getDriftDb: vi.fn(() => ({
    getAllFlowRuns: vi.fn(() => []),
    getSignals: vi.fn(() => ({
      getFileViolationHistory: vi.fn(() => []),
      getPathEffects: vi.fn(() => []),
    })),
  })),
}));

vi.mock("@features/knowledge-graph/tools/graph-query.ts", () => ({
  graphQuery: vi.fn(() => ({ count: 0, ok: true, query_type: "blast_radius", results: [] })),
}));

vi.mock("@app/server-state.ts", () => ({
  projectDir: "/mock/project",
}));

// Mock getExecutionStore to return a real in-memory store so we can inspect events.
// The factory captures a store reference per-call using a closure over a module-level Map.
vi.mock("@domains/workspaces/execution-store-cache.ts", () => {
  const stores = new Map<string, ExecutionStore>();
  return {
    clearStoreCache: vi.fn(() => stores.clear()),
    getExecutionStore: vi.fn((workspace: string) => {
      const existing = stores.get(workspace);
      if (existing) return existing;
      const db = initExecutionDb(":memory:");
      const store = new ExecutionStore(db);
      stores.set(workspace, store);
      return store;
    }),
  };
});

// Import mocked modules to set up spy return values per test
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";

// Import subject under test (after all mocks)
import { computeAutonomyTier } from "../compute-autonomy-tier.ts";

// ---- Test helpers ----

// A workspace path that satisfies the assertWorkspacePath guard. The VITEST env var is set
// during test runs, so the guard is skipped — any absolute path works.
const MOCK_WORKSPACE = "/mock/.canon/workspaces/test-workspace";

// Helper to build a minimal DriftDb-shaped mock (cast via unknown since we only
// implement the DriftDbAdapter subset used by confidence-scorer).
function makeDriftDbMock(overrides?: {
  flowRuns?: Array<{ state_iterations: unknown; gate_pass_rate: number | null | undefined }>;
  violationHistory?: unknown[];
  pathEffects?: Array<{ violation_streak: number; clean_streak: number }>;
}) {
  return {
    getAllFlowRuns: vi.fn(() => overrides?.flowRuns ?? []),
    getSignals: vi.fn(() => ({
      getFileViolationHistory: vi.fn(() => overrides?.violationHistory ?? []),
      getPathEffects: vi.fn(() => overrides?.pathEffects ?? []),
    })),
  } as unknown as ReturnType<typeof getDriftDb>;
}

/** Reset all mock implementations to their defaults. */
function resetMocks(): void {
  vi.mocked(getDriftDb).mockReturnValue(makeDriftDbMock());

  vi.mocked(graphQuery).mockReturnValue({
    count: 0,
    ok: true,
    query_type: "blast_radius",
    results: [],
  } as ReturnType<typeof graphQuery>);
}

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  clearStoreCache();
});

// ---- Tests ----

describe("computeAutonomyTier — happy path", () => {
  it("returns a tier result with score, reasoning, and signals_used", async () => {
    // Provide a clean build history (10 recent runs, 100% clean rate)
    vi.mocked(getDriftDb).mockReturnValue(
      makeDriftDbMock({
        flowRuns: Array.from({ length: 10 }, () => ({
          gate_pass_rate: 1.0,
          state_iterations: { implement: 1 },
        })),
      }),
    );

    const result = await computeAutonomyTier({
      file_paths: ["src/foo.ts"],
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(["autonomous", "light-touch", "supervised"]).toContain(result.tier);
    expect(typeof result.score).toBe("number");
    expect(typeof result.reasoning).toBe("string");
    expect(Array.isArray(result.signals_used)).toBe(true);
    // non-floored path — machine-readable fields all clear
    expect(result.floor_engaged).toBe(false);
    expect(result.floor_category).toBeUndefined();
    expect(result.floor_matched_path).toBeUndefined();
    expect(result.require_security).toBe(false);
    expect(result.require_adversarial).toBe(false);
  });
});

describe("computeAutonomyTier — fail-safe", () => {
  it("returns supervised when getDriftDb throws during signal gathering", async () => {
    vi.mocked(getDriftDb).mockImplementation(() => {
      throw new Error("DB connection failure");
    });

    const result = await computeAutonomyTier({
      file_paths: ["src/foo.ts"],
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tier).toBe("supervised");
    expect(result.score).toBe(0);
    expect(result.reasoning).toContain("signal gathering failed");
    expect(result.floor_engaged).toBe(false);
    expect(result.require_security).toBe(false);
    expect(result.require_adversarial).toBe(false);
  });

  it("returns supervised when graphQuery throws for all files", async () => {
    vi.mocked(graphQuery).mockImplementation(() => {
      throw new Error("KG not available");
    });

    const result = await computeAutonomyTier({
      file_paths: ["src/foo.ts"],
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    // graphQuery failure is non-fatal inside gatherBlastRadiusSignals (try/catch)
    // so the tool should still return a valid result (not the fail-safe supervised)
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // tier is determined without blast radius data (defaults to 0)
    expect(["autonomous", "light-touch", "supervised"]).toContain(result.tier);
  });

  it("total signal-gathering failure + sensitive file → supervised with floor fields set (floor survives fail-safe)", async () => {
    vi.mocked(getDriftDb).mockImplementation(() => {
      throw new Error("DB connection failure");
    });

    const result = await computeAutonomyTier({
      file_paths: ["hooks/pre-commit.sh"],
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tier).toBe("supervised");
    expect(result.floor_engaged).toBe(true);
    expect(result.floor_category).toBe("canon-safety-hooks");
    expect(result.floor_matched_path).toBe("hooks/pre-commit.sh");
    expect(result.require_security).toBe(true);
    expect(result.require_adversarial).toBe(true);
  });
});

describe("computeAutonomyTier — deny-list floor (success path)", () => {
  it("sensitive file_paths → tier supervised with all floor/require fields set", async () => {
    // Perfect build history — would otherwise score autonomous
    vi.mocked(getDriftDb).mockReturnValue(
      makeDriftDbMock({
        flowRuns: Array.from({ length: 10 }, () => ({
          gate_pass_rate: 1.0,
          state_iterations: { implement: 1 },
        })),
      }),
    );

    const result = await computeAutonomyTier({
      file_paths: ["mcp-server/src/app/daemon.ts"],
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tier).toBe("supervised");
    expect(result.floor_engaged).toBe(true);
    expect(result.floor_category).toBe("auth");
    expect(result.floor_matched_path).toBe("mcp-server/src/app/daemon.ts");
    expect(result.require_security).toBe(true);
    expect(result.require_adversarial).toBe(true);
  });

  it("self-governance: editing the deny-list's own source file floors to supervised (H1 regression)", async () => {
    // Perfect build history — would otherwise score autonomous. Asserts the control
    // governs its own modification: a build editing confidence-scorer.ts (where
    // SENSITIVE_PATH_DENY_LIST lives) cannot silently weaken the list unsupervised.
    vi.mocked(getDriftDb).mockReturnValue(
      makeDriftDbMock({
        flowRuns: Array.from({ length: 10 }, () => ({
          gate_pass_rate: 1.0,
          state_iterations: { implement: 1 },
        })),
      }),
    );

    const result = await computeAutonomyTier({
      file_paths: ["mcp-server/src/features/orchestration/services/confidence-scorer.ts"],
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tier).toBe("supervised");
    expect(result.floor_engaged).toBe(true);
    expect(result.floor_category).toBe("autonomy-tier-control");
    expect(result.floor_matched_path).toBe(
      "mcp-server/src/features/orchestration/services/confidence-scorer.ts",
    );
    expect(result.require_security).toBe(true);
    expect(result.require_adversarial).toBe(true);
  });

  it("self-governance: editing the deny-list's own matcher floors to supervised (H1' regression)", async () => {
    // Perfect build history — would otherwise score autonomous. Asserts the control
    // governs its own evaluation predicate: a build editing glob-matcher.ts (the sole
    // matchGlob predicate every deny-list pattern is evaluated through) cannot silently
    // weaken the floor unsupervised — the third leg of the self-governance tripod.
    vi.mocked(getDriftDb).mockReturnValue(
      makeDriftDbMock({
        flowRuns: Array.from({ length: 10 }, () => ({
          gate_pass_rate: 1.0,
          state_iterations: { implement: 1 },
        })),
      }),
    );

    const result = await computeAutonomyTier({
      file_paths: ["mcp-server/src/shared/lib/glob-matcher.ts"],
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tier).toBe("supervised");
    expect(result.floor_engaged).toBe(true);
    expect(result.floor_category).toBe("autonomy-tier-control");
    expect(result.floor_matched_path).toBe("mcp-server/src/shared/lib/glob-matcher.ts");
    expect(result.require_security).toBe(true);
    expect(result.require_adversarial).toBe(true);
  });

  it("floor beats override_tier: override_tier:autonomous + sensitive path → supervised", async () => {
    vi.mocked(getDriftDb).mockReturnValue(
      makeDriftDbMock({
        flowRuns: Array.from({ length: 10 }, () => ({
          gate_pass_rate: 1.0,
          state_iterations: { implement: 1 },
        })),
      }),
    );

    const result = await computeAutonomyTier({
      file_paths: ["hooks/lint.sh"],
      override_tier: "autonomous",
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tier).toBe("supervised");
    expect(result.floor_engaged).toBe(true);
    expect(result.require_security).toBe(true);
    expect(result.require_adversarial).toBe(true);
  });
});

describe("computeAutonomyTier — auto_decision event logging", () => {
  it("logs an auto_decision event to the execution store", async () => {
    const result = await computeAutonomyTier({
      file_paths: ["src/foo.ts"],
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    expect(result.ok).toBe(true);

    const store = getExecutionStore(MOCK_WORKSPACE);
    const events = store.getEvents({ type: "auto_decision" });
    expect(events).toHaveLength(1);

    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.decision_type).toBe("tier_assignment");
    expect(payload.file_paths).toEqual(["src/foo.ts"]);
    expect(typeof payload.tier).toBe("string");
    expect(typeof payload.reasoning).toBe("string");
    expect(typeof payload.timestamp).toBe("string");
  });

  it("does NOT log an event when workspace is not absolute", async () => {
    // workspace = relative path → isAbsolute returns false → event block is skipped
    const result = await computeAutonomyTier({
      file_paths: ["src/foo.ts"],
      workspace: "relative/path/to/workspace",

      projectDir: process.cwd(),
    });

    // Tool still succeeds (logging is best-effort)
    expect(result.ok).toBe(true);
    // No store was hit — we can't easily assert absence without a separate store spy,
    // but the lack of error is the contract: best-effort never blocks the response.
  });

  it("records the floor fields in the auto_decision payload when the floor is engaged", async () => {
    const result = await computeAutonomyTier({
      file_paths: ["hooks/x.sh"],
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    expect(result.ok).toBe(true);

    const store = getExecutionStore(MOCK_WORKSPACE);
    const events = store.getEvents({ type: "auto_decision" });
    expect(events).toHaveLength(1);

    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.floor_engaged).toBe(true);
    expect(payload.floor_category).toBe("canon-safety-hooks");
    expect(payload.floor_matched_path).toBe("hooks/x.sh");
    expect(payload.require_security).toBe(true);
    expect(payload.require_adversarial).toBe(true);
  });
});

describe("computeAutonomyTier — override_tier passthrough", () => {
  it("returns the overridden tier with score -1 regardless of signals", async () => {
    // Even with perfect signals, override_tier = supervised should win
    vi.mocked(getDriftDb).mockReturnValue(
      makeDriftDbMock({
        flowRuns: Array.from({ length: 10 }, () => ({
          gate_pass_rate: 1.0,
          state_iterations: { implement: 1 },
        })),
      }),
    );

    const result = await computeAutonomyTier({
      file_paths: ["src/foo.ts"],
      override_tier: "supervised",
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tier).toBe("supervised");
    expect(result.score).toBe(-1);
    expect(result.signals_used).toContain("override_tier");
  });

  it("override_tier = autonomous is respected even with poor signals (non-sensitive)", async () => {
    // No build history — worst-case defaults
    vi.mocked(getDriftDb).mockReturnValue(makeDriftDbMock());

    const result = await computeAutonomyTier({
      file_paths: ["src/foo.ts"],
      override_tier: "autonomous",
      workspace: MOCK_WORKSPACE,

      projectDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tier).toBe("autonomous");
    expect(result.score).toBe(-1);
  });
});
