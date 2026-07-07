/**
 * write-receipt-gate — integration tests for the fail-closed write-receipt
 * completion gate (`enforceWriteReceipt`) wired into `logStep` and
 * `batchLogSteps`. Covers the DESIGN.md False-Close table rows and the
 * enforce-always (no mode knob) posture. See ADR-0042.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk, isToolError } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Journal } from "../orchestration-journal.ts";
import { batchLogSteps, logStep } from "../orchestration-journal.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-write-receipt-gate-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

async function readJournalFile(ws: string): Promise<Journal> {
  const raw = await readFile(join(ws, "journal.json"), "utf-8");
  return JSON.parse(raw) as Journal;
}

function emitReceipt(kind: string): void {
  const store = getExecutionStore(workspace);
  store.appendEvent("write_receipt", {
    artifact_kind: kind,
    artifact_path: "irrelevant-for-this-test",
    written_at: new Date().toISOString(),
  });
}

describe("enforceWriteReceipt via logStep — strong path (receipt present)", () => {
  it("engineer completed WITH a receipt after started_at -> pass", async () => {
    await logStep({
      agent_type: "engineer",
      status: "started",
      step_id: "implement",
      workspace,
      projectDir: process.cwd(),
    });

    emitReceipt("implementation_summary");

    const result = await logStep({
      agent_id: "eng-01",
      agent_type: "engineer",
      status: "completed",
      step_id: "implement",
      workspace,
      projectDir: process.cwd(),
    });

    assertOk(result);
  });

  it.each([
    ["architect", "design", "design"],
    ["scribe", "context_sync", "context-sync"],
    ["security", "security_assessment", "security"],
  ] as const)("%s completed WITH its new-tool receipt -> pass (all-6 coverage)", async (agentType, kind, stepId) => {
    await logStep({
      agent_type: agentType,
      status: "started",
      step_id: stepId,
      workspace,
      projectDir: process.cwd(),
    });
    emitReceipt(kind);
    const result = await logStep({
      agent_id: `${agentType}-01`,
      agent_type: agentType,
      status: "completed",
      step_id: stepId,
      workspace,
      projectDir: process.cwd(),
    });
    assertOk(result);
  });
});

describe("enforceWriteReceipt via logStep — WR-02 fallback (no receipt, real file on disk)", () => {
  it("engineer completed WITHOUT a receipt but a real SUMMARY on disk -> pass + weak-pass telemetry", async () => {
    await logStep({
      agent_type: "engineer",
      status: "started",
      step_id: "implement",
      workspace,
      projectDir: process.cwd(),
    });

    mkdirSync(join(workspace, "plans", "my-slug"), { recursive: true });
    writeFileSync(
      join(workspace, "plans", "my-slug", "implement-SUMMARY.md"),
      "## Implementation Summary: implement\n\nDone.\n",
    );

    const result = await logStep({
      agent_id: "eng-02",
      agent_type: "engineer",
      status: "completed",
      step_id: "implement",
      workspace,
      projectDir: process.cwd(),
    });

    assertOk(result);

    const store = getExecutionStore(workspace);
    const weakPassEvents = store.getEvents({ type: "write_receipt_weak_pass" });
    expect(weakPassEvents).toHaveLength(1);
    expect(weakPassEvents[0].payload.step_id).toBe("implement");
  });

  it("no receipt + file present but a Status: Partial skeleton -> reject (skeleton tightening)", async () => {
    await logStep({
      agent_type: "engineer",
      status: "started",
      step_id: "implement",
      workspace,
      projectDir: process.cwd(),
    });

    mkdirSync(join(workspace, "plans", "my-slug"), { recursive: true });
    writeFileSync(
      join(workspace, "plans", "my-slug", "implement-SUMMARY.md"),
      "## Status: Partial\n\nStill working.\n",
    );

    const result = await logStep({
      agent_id: "eng-03",
      agent_type: "engineer",
      status: "completed",
      step_id: "implement",
      workspace,
      projectDir: process.cwd(),
    });

    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.context?.receipt_missing).toEqual(["implementation_summary"]);
    }
  });
});

describe("enforceWriteReceipt via logStep — genuine no-receipt-and-no-file reject", () => {
  it("engineer completed, no receipt AND no file -> reject", async () => {
    await logStep({
      agent_type: "engineer",
      status: "started",
      step_id: "implement",
      workspace,
      projectDir: process.cwd(),
    });

    const result = await logStep({
      agent_id: "eng-04",
      agent_type: "engineer",
      status: "completed",
      step_id: "implement",
      workspace,
      projectDir: process.cwd(),
    });

    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("no write receipt and no artifact on disk");
    }

    // Step must NOT have been marked completed in the journal.
    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "implement");
    expect(step?.status).toBe("started");
  });
});

describe("enforceWriteReceipt via logStep — structural pass-throughs", () => {
  it("shipper completed, no receipt -> pass (not in map)", async () => {
    await logStep({
      agent_type: "shipper",
      status: "started",
      step_id: "ship",
      workspace,
      projectDir: process.cwd(),
    });

    const result = await logStep({
      agent_id: "ship-01",
      agent_type: "shipper",
      status: "completed",
      step_id: "ship",
      workspace,
      projectDir: process.cwd(),
    });

    assertOk(result);
  });

  it("eval-fix-1 engineer completed, no receipt/file -> pass (exempt step pattern)", async () => {
    await logStep({
      agent_type: "engineer",
      status: "started",
      step_id: "eval-fix-1",
      workspace,
      projectDir: process.cwd(),
    });

    const result = await logStep({
      agent_id: "eng-fix-01",
      agent_type: "engineer",
      status: "completed",
      step_id: "eval-fix-1",
      workspace,
      projectDir: process.cwd(),
    });

    assertOk(result);
  });

  it("a step with no agent_type at all -> pass (backward compat, pre-existing callers)", async () => {
    await logStep({
      status: "started",
      step_id: "plan",
      workspace,
      projectDir: process.cwd(),
    });

    const result = await logStep({
      agent_id: "plan-01",
      status: "completed",
      step_id: "plan",
      workspace,
      projectDir: process.cwd(),
    });

    assertOk(result);
  });
});

describe("enforceWriteReceipt via logStep — resume/replay", () => {
  it("re-logging an already-completed step whose original receipt predates started_at -> pass", async () => {
    await logStep({
      agent_type: "reviewer",
      status: "started",
      step_id: "review",
      workspace,
      projectDir: process.cwd(),
    });
    emitReceipt("review");

    const first = await logStep({
      agent_id: "rev-01",
      agent_type: "reviewer",
      status: "completed",
      step_id: "review",
      workspace,
      projectDir: process.cwd(),
    });
    assertOk(first);

    // Re-log the same completed step (resume/replay) — the original receipt
    // (ts >= started_at) still satisfies the gate.
    const second = await logStep({
      agent_id: "rev-01",
      agent_type: "reviewer",
      status: "completed",
      step_id: "review",
      workspace,
      projectDir: process.cwd(),
    });
    assertOk(second);
  });
});

describe("enforceWriteReceipt via logStep — gate infra failure fails open", () => {
  it("getEvents throwing does not block completion", async () => {
    await logStep({
      agent_type: "engineer",
      status: "started",
      step_id: "implement",
      workspace,
      projectDir: process.cwd(),
    });

    const store = getExecutionStore(workspace);
    const spy = vi.spyOn(store, "getEvents").mockImplementation(() => {
      throw new Error("simulated corrupt store");
    });

    const result = await logStep({
      agent_id: "eng-05",
      agent_type: "engineer",
      status: "completed",
      step_id: "implement",
      workspace,
      projectDir: process.cwd(),
    });

    assertOk(result);
    spy.mockRestore();
  });
});

describe("enforceWriteReceipt via batchLogSteps — batch atomicity", () => {
  it("one no-receipt-no-file engineer entry rejects the whole batch; journal unwritten", async () => {
    const steps = [
      { agent_type: "reviewer" as const, status: "started" as const, step_id: "review" },
      { agent_type: "engineer" as const, status: "started" as const, step_id: "implement" },
    ];
    await batchLogSteps({ projectDir: process.cwd(), steps, workspace });

    emitReceipt("review");

    const result = await batchLogSteps({
      projectDir: process.cwd(),
      steps: [
        {
          agent_id: "rev-02",
          agent_type: "reviewer",
          status: "completed",
          step_id: "review",
        },
        {
          agent_id: "eng-06",
          agent_type: "engineer",
          status: "completed",
          step_id: "implement",
        },
      ],
      workspace,
    });

    expect(isToolError(result)).toBe(true);

    const journal = await readJournalFile(workspace);
    const reviewStep = journal.steps.find((s) => s.step_id === "review");
    const implementStep = journal.steps.find((s) => s.step_id === "implement");
    // Whole batch rejected — neither entry transitioned to completed.
    expect(reviewStep?.status).toBe("started");
    expect(implementStep?.status).toBe("started");
  });
});
