/**
 * report-result-persistence.test.ts — Tests for store persistence, concurrent
 * RMW serialization, workspace-not-found errors, symlink guard, and required
 * handoffs validation in reportResult.
 *
 * All workspace setup uses ExecutionStore instead of readBoard/writeBoard.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedFlow as FlowType } from "@domains/flows/flow-definition-schemas.ts";
import { flowEventBus } from "@domains/messages/event-bus-instance.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { reportResult, validateRequiredHandoffs } from "../tools/report-result.ts";

function makeMinimalFlow(overrides?: Partial<FlowType>): FlowType {
  return {
    description: "A test flow",
    entry: "build",
    name: "test-flow",
    spawn_instructions: {},
    states: {
      build: {
        transitions: {
          done: "review",
          failed: "hitl",
        },
        type: "single",
      },
      hitl: { type: "terminal" },
      review: {
        transitions: {
          done: "ship",
        },
        type: "single",
      },
      ship: { type: "terminal" },
    },
    ...overrides,
  };
}

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "report-result-pers-test-"));
  tmpDirs.push(dir);
  return dir;
}

function setupWorkspace(workspace: string, flow: FlowType): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();

  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });

  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { entries: 0, status: "pending" });
  }
}

afterEach(() => {
  clearStoreCache();

  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  flowEventBus.removeAllListeners();
});

// Store persistence — full mutation chain

describe("reportResult — store persistence", () => {
  it("full mutation chain: status normalization → transition → board persistence", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      artifacts: ["plan.md"],
      flow,
      gate_results: [
        { command: "npm test", exitCode: 0, gate: "npm test", output: "", passed: true },
      ],
      metrics: { duration_ms: 2000, model: "sonnet", spawns: 2 },
      state_id: "build",
      status_keyword: "DONE",
      violation_count: 0,
      workspace,
    });
    assertOk(result);

    // All mutation steps persisted
    const store = getExecutionStore(workspace);
    const state = store.getState("build");
    expect(state?.status).toBe("done");
    expect(state?.artifacts).toEqual(["plan.md"]);
    expect(state?.gate_results).toBeDefined();
    expect(state?.metrics?.duration_ms).toBe(2000);

    const exec = store.getExecution();
    expect(exec?.current_state).toBe("review");

    // Result board accurate
    expect(result.board.current_state).toBe("review");
    expect(result.transition_condition).toBe("done");
    expect(result.hitl_required).toBe(false);
  });

  it("stuck detection updates iteration history in store", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow({
      states: {
        build: {
          max_iterations: 5,
          stuck_when: "same_status",
          transitions: { done: "review", failed: "build" },
          type: "single",
        },
        hitl: { type: "terminal" },
        review: { transitions: { done: "ship" }, type: "single" },
        ship: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    // Seed iteration entry
    const store = getExecutionStore(workspace);
    store.upsertIteration("build", {
      cannot_fix: [],
      count: 1,
      history: [{ status: "failed" }],
      max: 5,
    });

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "FAILED",
      workspace,
    });
    assertOk(result);

    // History updated in store
    const iter = store.getIteration("build");
    expect(iter?.history.length).toBeGreaterThan(1);

    // If stuck, hitl_required
    if (result.stuck) {
      expect(result.hitl_required).toBe(true);
    }
  });
});

// Concurrent read-modify-write — P1 fix: entire RMW inside transaction

describe("reportResult — concurrent RMW serialization (P1)", () => {
  it("two concurrent calls accumulating discovered_gates preserve both sets", async () => {
    // Demonstrates the lost-update bug: without the entire RMW inside a
    // transaction, the second concurrent writer reads stale board state
    // (before the first writer's discovered_gates were committed) and
    // overwrites them. With the fix, both gate sets survive.
    const workspace = makeTmpWorkspace();

    // Use a state that transitions to itself so both callers can use the same state_id
    const flow = makeMinimalFlow({
      states: {
        build: {
          transitions: { done: "review", failed: "build" },
          type: "single",
        },
        hitl: { type: "terminal" },
        review: { transitions: { done: "ship" }, type: "single" },
        ship: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    // Two concurrent calls each reporting a distinct discovered gate
    const [r1, r2] = await Promise.all([
      reportResult({
        discovered_gates: [{ command: "npm test", source: "agent-1" }],
        flow,
        state_id: "build",
        status_keyword: "DONE",
        workspace,
      }),
      reportResult({
        discovered_gates: [{ command: "npm run lint", source: "agent-2" }],
        flow,
        state_id: "build",
        status_keyword: "DONE",
        workspace,
      }),
    ]);

    // Both calls should succeed
    assertOk(r1);
    assertOk(r2);
    expect(r1.transition_condition).toBe("done");
    expect(r2.transition_condition).toBe("done");

    // The persisted state should contain discovered_gates from BOTH calls
    // (accumulated, not overwritten). With the stale-read bug present,
    // only one set survives; with the fix both are present.
    const store = getExecutionStore(workspace);
    const state = store.getState("build");
    const gates = state?.discovered_gates ?? [];

    // Both gate commands must be present after concurrent accumulation
    const commands = gates.map((g: { command: string }) => g.command);
    expect(commands).toContain("npm test");
    expect(commands).toContain("npm run lint");
  });
});

// Workspace not found — typed WORKSPACE_NOT_FOUND error

describe("reportResult — workspace not found", () => {
  it("returns WORKSPACE_NOT_FOUND ToolResult when workspace has no execution", async () => {
    const workspace = makeTmpWorkspace(); // not seeded — no execution row

    const flow = makeMinimalFlow();
    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    expect(result.message).toContain(workspace);
  });
});

// Required handoffs — symlink guard (ADR-018 security follow-up)
// Tests validateRequiredHandoffs directly to avoid the pre-existing syncBoardToStore issue.

describe("validateRequiredHandoffs — symlink guard", () => {
  it("symlink in handoffs/ pointing outside workspace produces a warning (non-blocking)", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { symlink } = await import("node:fs/promises");
    const workspace = makeTmpWorkspace();
    const outsideDir = mkdtempSync(join(tmpdir(), "outside-workspace-"));
    tmpDirs.push(outsideDir);

    // Create handoffs dir and write target meta.json outside workspace
    mkdirSync(join(workspace, "handoffs"), { recursive: true });
    const targetMeta = join(outsideDir, "evil-link.meta.json");
    writeFileSync(targetMeta, JSON.stringify({ _type: "some-type", _version: 1 }));

    // Create a symlink inside handoffs/ pointing to the file outside workspace
    await symlink(targetMeta, join(workspace, "handoffs", "evil-link.meta.json"));

    // Call validateRequiredHandoffs directly — no reportResult overhead
    const warnings = await validateRequiredHandoffs(workspace, [
      { name: "evil-link", type: "some-type" },
    ]);

    // Symlink escape should be caught and produce a warning (non-blocking)
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("evil-link"))).toBe(true);
  });

  it("normal file inside workspace produces no warning", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const workspace = makeTmpWorkspace();

    mkdirSync(join(workspace, "handoffs"), { recursive: true });
    writeFileSync(
      join(workspace, "handoffs", "legit.meta.json"),
      JSON.stringify({ _type: "some-type", _version: 1 }),
    );

    const warnings = await validateRequiredHandoffs(workspace, [
      { name: "legit", type: "some-type" },
    ]);

    expect(warnings).toHaveLength(0);
  });
});

// Required handoffs — non-blocking warnings (ADR-018)

describe("reportResult — required_handoffs validation", () => {
  function makeFlowWithHandoffs(handoffs: Array<{ name: string; type: string }>): FlowType {
    return makeMinimalFlow({
      states: {
        build: {
          required_handoffs: handoffs,
          transitions: { done: "review", failed: "hitl" },
          type: "single",
        },
        hitl: { type: "terminal" },
        review: { transitions: { done: "ship" }, type: "single" },
        ship: { type: "terminal" },
      },
    });
  }

  it("no required_handoffs: behaves identically, no warnings field", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.ok).toBe(true);
    expect((result as Record<string, unknown>).warnings).toBeUndefined();
    expect(result.transition_condition).toBe("done");
    expect(result.next_state).toBe("review");
  });

  it("required_handoffs with matching meta.json: ok true, no warnings", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithHandoffs([{ name: "research", type: "research-summary" }]);
    setupWorkspace(workspace, flow);

    // Create handoffs directory and write meta.json
    const handoffsDir = join(workspace, "handoffs");
    mkdirSync(handoffsDir, { recursive: true });
    writeFileSync(
      join(handoffsDir, "research.meta.json"),
      JSON.stringify({ _type: "research-summary", _version: 1 }),
    );

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.ok).toBe(true);
    expect((result as Record<string, unknown>).warnings).toBeUndefined();
  });

  it("required_handoffs with missing meta.json: ok true, warnings present", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithHandoffs([{ name: "design-doc", type: "handoff-document" }]);
    setupWorkspace(workspace, flow);

    // Do NOT create handoffs/design-doc.meta.json

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.ok).toBe(true);
    const warnings = (result as Record<string, unknown>).warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings![0]).toContain("design-doc");
    expect(warnings![0]).toContain("not found");
  });

  it("required_handoffs with wrong _type in meta.json: ok true, warnings present", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithHandoffs([{ name: "plan", type: "implementation-plan" }]);
    setupWorkspace(workspace, flow);

    // Create handoffs directory with WRONG _type
    const handoffsDir = join(workspace, "handoffs");
    mkdirSync(handoffsDir, { recursive: true });
    writeFileSync(
      join(handoffsDir, "plan.meta.json"),
      JSON.stringify({ _type: "research-summary", _version: 1 }),
    );

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.ok).toBe(true);
    const warnings = (result as Record<string, unknown>).warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.length).toBeGreaterThan(0);
    expect(warnings![0]).toContain("plan");
    expect(warnings![0]).toContain("research-summary");
    expect(warnings![0]).toContain("implementation-plan");
  });

  it("warnings field absent from result when no handoff issues", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const workspace = makeTmpWorkspace();
    const flow = makeFlowWithHandoffs([{ name: "arch", type: "architecture-decision" }]);
    setupWorkspace(workspace, flow);

    const handoffsDir = join(workspace, "handoffs");
    mkdirSync(handoffsDir, { recursive: true });
    writeFileSync(
      join(handoffsDir, "arch.meta.json"),
      JSON.stringify({ _type: "architecture-decision", _version: 1 }),
    );

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    // When no issues, warnings must be absent (not empty array)
    expect(Object.hasOwn(result, "warnings")).toBe(false);
  });
});
