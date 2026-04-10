/**
 * Tests for report_result baseline evidence consistency check (argu-02).
 *
 * Covers:
 * 1.  DONE + failed=5 + no baseline_evidence → INVALID_INPUT error
 * 2.  DONE_WITH_CONCERNS + failed=5 + no baseline_evidence → INVALID_INPUT error
 * 3.  DONE + failed=5 + baseline_evidence with new_failures=[] → success with escalate_to_hitl set
 * 4.  DONE + failed=5 + baseline_evidence with new_failures=["test_x"] → INVALID_INPUT error
 * 5.  DONE + failed=0 → success (no check needed)
 * 6.  DONE + no test_results → success (backward compat)
 * 7.  IMPLEMENTATION_ISSUE + failed=5 → success (non-success status, no check)
 * 8.  ALL_PASSING + failed=1 + no baseline_evidence → INVALID_INPUT error
 * 9.  FIXED + failed=2 + no baseline_evidence → INVALID_INPUT error
 * 10. DONE_WITH_CONCERNS + failed=3 + baseline_evidence with new_failures=[] → success with escalate_to_hitl
 * 11. PARTIAL_FIX + failed=1 + no baseline_evidence → INVALID_INPUT error
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("@domains/messages/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("../engine/effects.ts", () => ({
  executeEffects: vi.fn().mockResolvedValue(undefined),
}));

import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { isToolError } from "@shared/lib/tool-result.ts";
import { reportResult } from "../tools/report-result.ts";
import { flowName } from "@domains/flows/board-state-schemas.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "baseline-report-result-"));
}

function makeMinimalFlow(): ResolvedFlow {
  return {
    description: "test flow",
    entry: "impl",
    name: flowName("test-flow"),
    spawn_instructions: { impl: "Do the thing" },
    states: {
      impl: {
        agent: "canon:canon-implementor",
        transitions: {
          done: "terminal",
          hitl: "terminal",
          implementation_issue: "impl",
        },
        type: "single",
      },
      terminal: { type: "terminal" },
    },
  } as ResolvedFlow;
}

function makeMinimalBaselineEvidence(overrides?: {
  new_failures?: string[];
  current_failures?: string[];
  baseline_failures?: string[];
}) {
  return {
    baseline_commit: "abc123",
    baseline_failures: overrides?.baseline_failures ?? ["pre-existing-test"],
    current_failures: overrides?.current_failures ?? ["pre-existing-test"],
    new_failures: overrides?.new_failures ?? [],
  };
}

let tmpDirs: string[] = [];

function setupWorkspace(): string {
  const workspace = makeTmpWorkspace();
  tmpDirs.push(workspace);

  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc123",
    branch: "main",
    created: now,
    current_state: "impl",
    entry: "impl",
    flow: flowName("test-flow"),
    flow_name: "test-flow",
    last_updated: now,
    sanitized: "main",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });
  store.upsertState("impl", { entries: 1, status: "in_progress" });
  store.upsertIteration("impl", { cannot_fix: [], count: 1, history: [], max: 3 });

  return workspace;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("report_result: baseline evidence consistency check", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    tmpDirs = [];
    vi.clearAllMocks();
  });

  // Test 1: DONE + failed=5 + no baseline_evidence → INVALID_INPUT
  it("returns INVALID_INPUT when DONE with test failures and no baseline_evidence", async () => {
    const workspace = setupWorkspace();
    const result = await reportResult({
      flow: makeMinimalFlow(),
      state_id: "impl",
      status_keyword: "DONE",
      test_results: { failed: 5, passed: 10, skipped: 0 },
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error("Expected tool error");
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.recoverable).toBe(true);
    expect(result.message).toContain("DONE");
    expect(result.message).toContain("5");
    expect(result.message).toContain("baseline_evidence");
  });

  // Test 2: DONE_WITH_CONCERNS + failed=5 + no baseline_evidence → INVALID_INPUT
  it("returns INVALID_INPUT when DONE_WITH_CONCERNS with test failures and no baseline_evidence", async () => {
    const workspace = setupWorkspace();
    const result = await reportResult({
      flow: makeMinimalFlow(),
      state_id: "impl",
      status_keyword: "DONE_WITH_CONCERNS",
      test_results: { failed: 5, passed: 10, skipped: 0 },
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error("Expected tool error");
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.recoverable).toBe(true);
    expect(result.message).toContain("DONE_WITH_CONCERNS");
    expect(result.message).toContain("baseline_evidence");
  });

  // Test 3: DONE + failed=5 + baseline_evidence with new_failures=[] → success with escalate_to_hitl
  it("succeeds with escalate_to_hitl when all failures are pre-existing with evidence", async () => {
    const workspace = setupWorkspace();
    const evidence = makeMinimalBaselineEvidence({ new_failures: [] });

    const result = await reportResult({
      baseline_evidence: evidence,
      flow: makeMinimalFlow(),
      state_id: "impl",
      status_keyword: "DONE",
      test_results: { failed: 5, passed: 10, skipped: 0 },
      workspace,
    });

    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) throw new Error("Expected success");
    expect(result.ok).toBe(true);
    expect(result.escalate_to_hitl).toBeDefined();
    expect(result.escalate_to_hitl?.reason).toBeTruthy();
    expect(result.escalate_to_hitl?.baseline_evidence).toEqual(evidence);
  });

  // Test 4: DONE + failed=5 + baseline_evidence with new_failures=["test_x"] → INVALID_INPUT
  it("returns INVALID_INPUT when baseline_evidence shows new failures", async () => {
    const workspace = setupWorkspace();
    const evidence = makeMinimalBaselineEvidence({
      new_failures: ["test_x", "test_y"],
    });

    const result = await reportResult({
      baseline_evidence: evidence,
      flow: makeMinimalFlow(),
      state_id: "impl",
      status_keyword: "DONE",
      test_results: { failed: 5, passed: 10, skipped: 0 },
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error("Expected tool error");
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.recoverable).toBe(true);
    expect(result.message).toContain("2");
    expect(result.message).toContain("test_x");
  });

  // Test 5: DONE + failed=0 → success (no failures, no check needed)
  it("succeeds when DONE with zero test failures", async () => {
    const workspace = setupWorkspace();
    const result = await reportResult({
      flow: makeMinimalFlow(),
      state_id: "impl",
      status_keyword: "DONE",
      test_results: { failed: 0, passed: 20, skipped: 0 },
      workspace,
    });

    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) throw new Error("Expected success");
    expect(result.ok).toBe(true);
    expect(result.escalate_to_hitl).toBeUndefined();
  });

  // Test 6: DONE + no test_results → success (backward compat)
  it("succeeds when DONE with no test_results (backward compatibility)", async () => {
    const workspace = setupWorkspace();
    const result = await reportResult({
      flow: makeMinimalFlow(),
      state_id: "impl",
      status_keyword: "DONE",
      workspace,
    });

    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) throw new Error("Expected success");
    expect(result.ok).toBe(true);
    expect(result.escalate_to_hitl).toBeUndefined();
  });

  // Test 7: IMPLEMENTATION_ISSUE + failed=5 → success (non-success status, no check)
  it("succeeds when IMPLEMENTATION_ISSUE with test failures (non-success status bypasses check)", async () => {
    const workspace = setupWorkspace();
    const result = await reportResult({
      flow: makeMinimalFlow(),
      state_id: "impl",
      status_keyword: "IMPLEMENTATION_ISSUE",
      test_results: { failed: 5, passed: 3, skipped: 0 },
      workspace,
    });

    // IMPLEMENTATION_ISSUE transitions back to impl which is fine
    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) throw new Error("Expected success");
    expect(result.ok).toBe(true);
    expect(result.escalate_to_hitl).toBeUndefined();
  });

  // Test 8: ALL_PASSING + failed=1 + no baseline_evidence → INVALID_INPUT
  it("returns INVALID_INPUT when ALL_PASSING with test failures and no baseline_evidence", async () => {
    const workspace = setupWorkspace();
    const result = await reportResult({
      flow: makeMinimalFlow(),
      state_id: "impl",
      status_keyword: "ALL_PASSING",
      test_results: { failed: 1, passed: 15, skipped: 0 },
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error("Expected tool error");
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.recoverable).toBe(true);
    expect(result.message).toContain("ALL_PASSING");
    expect(result.message).toContain("baseline_evidence");
  });

  // Test 9: FIXED + failed=2 + no baseline_evidence → INVALID_INPUT
  it("returns INVALID_INPUT when FIXED with test failures and no baseline_evidence", async () => {
    const workspace = setupWorkspace();
    const result = await reportResult({
      flow: makeMinimalFlow(),
      state_id: "impl",
      status_keyword: "FIXED",
      test_results: { failed: 2, passed: 8, skipped: 0 },
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error("Expected tool error");
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.recoverable).toBe(true);
    expect(result.message).toContain("FIXED");
    expect(result.message).toContain("baseline_evidence");
  });

  // Test 10: DONE_WITH_CONCERNS + failed=3 + baseline_evidence with new_failures=[] → success with escalate_to_hitl
  it("succeeds with escalate_to_hitl when DONE_WITH_CONCERNS with all pre-existing failures", async () => {
    const workspace = setupWorkspace();
    const evidence = makeMinimalBaselineEvidence({ new_failures: [] });

    const result = await reportResult({
      baseline_evidence: evidence,
      concern_text: "Some pre-existing tests are still failing",
      flow: makeMinimalFlow(),
      state_id: "impl",
      status_keyword: "DONE_WITH_CONCERNS",
      test_results: { failed: 3, passed: 7, skipped: 0 },
      workspace,
    });

    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) throw new Error("Expected success");
    expect(result.ok).toBe(true);
    expect(result.escalate_to_hitl).toBeDefined();
    expect(result.escalate_to_hitl?.reason).toBeTruthy();
    expect(result.escalate_to_hitl?.baseline_evidence).toEqual(evidence);
  });

  // Test 11: PARTIAL_FIX + failed=1 + no baseline_evidence → INVALID_INPUT
  it("returns INVALID_INPUT when PARTIAL_FIX with test failures and no baseline_evidence", async () => {
    const workspace = setupWorkspace();
    const result = await reportResult({
      flow: makeMinimalFlow(),
      state_id: "impl",
      status_keyword: "PARTIAL_FIX",
      test_results: { failed: 1, passed: 5, skipped: 0 },
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) throw new Error("Expected tool error");
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.recoverable).toBe(true);
    expect(result.message).toContain("PARTIAL_FIX");
    expect(result.message).toContain("baseline_evidence");
  });
});
