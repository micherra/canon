/**
 * write-receipt-gate — integration tests for the fail-closed write-receipt
 * completion gate (`enforceWriteReceipt`) wired into `logStep` and
 * `batchLogSteps`. Covers the DESIGN.md False-Close table rows and the
 * enforce-always (no mode knob) posture. See ADR-0043.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk, isToolError } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedExecution } from "../../__tests__/seed-execution-test-helper.ts";
import type { Journal } from "../orchestration-journal.ts";
import { batchLogSteps, logStep } from "../orchestration-journal.ts";
import { writeDesign } from "../write-design.ts";
import { writeReview } from "../write-review.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-write-receipt-gate-"));
  seedExecution(workspace);
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

describe("enforceWriteReceipt via logStep — security early-scan exemption", () => {
  it("security completed under a reserved early-scan step_id, no receipt/file -> pass (exempt)", async () => {
    await logStep({
      agent_type: "security",
      status: "started",
      step_id: "security-early-scan",
      workspace,
      projectDir: process.cwd(),
    });

    const result = await logStep({
      agent_id: "sec-early-01",
      agent_type: "security",
      status: "completed",
      step_id: "security-early-scan",
      workspace,
      projectDir: process.cwd(),
    });

    assertOk(result);
  });

  it("security completed under a NORMAL step_id, no receipt/file -> reject (guarantee preserved)", async () => {
    await logStep({
      agent_type: "security",
      status: "started",
      step_id: "security",
      workspace,
      projectDir: process.cwd(),
    });

    const result = await logStep({
      agent_id: "sec-01",
      agent_type: "security",
      status: "completed",
      step_id: "security",
      workspace,
      projectDir: process.cwd(),
    });

    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.context?.receipt_missing).toEqual(["security_assessment"]);
    }
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

describe("enforceWriteReceipt via logStep — skeleton write never receipts (Codex P1 regression)", () => {
  it("architect writes ONLY a Status: Partial skeleton via the real write_design tool -> completed step is REJECTED", async () => {
    await logStep({
      agent_type: "architect",
      status: "started",
      step_id: "design",
      workspace,
      projectDir: process.cwd(),
    });

    const skeletonResult = await writeDesign({
      content: "## Status: Partial\n\nStill researching.\n",
      slug: "my-slug",
      workspace,
    });
    assertOk(skeletonResult);

    // The skeleton write must NOT have emitted a receipt — this is the hole
    // being closed: under the old contract, ANY successful write emitted a
    // receipt, so a skeleton-only agent would pass the gate's strong path.
    const store = getExecutionStore(workspace);
    expect(store.getEvents({ type: "write_receipt" })).toHaveLength(0);

    const result = await logStep({
      agent_id: "arch-01",
      agent_type: "architect",
      status: "completed",
      step_id: "design",
      workspace,
      projectDir: process.cwd(),
    });

    // No receipt (skeleton never receipted) AND WR-02 also rejects — the
    // only file on disk is still the same skeleton -> genuine reject, not a
    // false PASS via either path.
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.context?.receipt_missing).toEqual(["design"]);
    }
  });

  it("architect finalizes the same DESIGN.md via write_design (real tool) -> completed step PASSES", async () => {
    await logStep({
      agent_type: "architect",
      status: "started",
      step_id: "design",
      workspace,
      projectDir: process.cwd(),
    });

    const finalResult = await writeDesign({
      content: "## Design: Something\n\nFull body, no longer partial.\n",
      slug: "my-slug",
      workspace,
    });
    assertOk(finalResult);

    const store = getExecutionStore(workspace);
    expect(store.getEvents({ type: "write_receipt" })).toHaveLength(1);

    const result = await logStep({
      agent_id: "arch-02",
      agent_type: "architect",
      status: "completed",
      step_id: "design",
      workspace,
      projectDir: process.cwd(),
    });

    assertOk(result);
  });
});

describe("enforceWriteReceipt via logStep — ADR-0063 step-scoped review writes (AC 5 / dc-05)", () => {
  it("reviewer completes via the strong path after a step_id-only writeReview call (receipt kind 'review')", async () => {
    await logStep({
      agent_type: "reviewer",
      status: "started",
      step_id: "review-lens-x",
      workspace,
      projectDir: process.cwd(),
    });

    const stepResult = await writeReview({
      files: ["src/foo.ts"],
      honored: [],
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 1, total: 1 },
        rules: { passed: 1, total: 1 },
      },
      slug: "my-slug",
      step_id: "lens-x",
      verdict: "approved",
      violations: [],
      workspace,
    });
    assertOk(stepResult);

    const store = getExecutionStore(workspace);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("review");

    const result = await logStep({
      agent_id: "rev-lens-x-01",
      agent_type: "reviewer",
      status: "completed",
      step_id: "review-lens-x",
      workspace,
      projectDir: process.cwd(),
    });

    assertOk(result);
  });

  it("WR-02: with no receipts, a non-skeleton reviews/REVIEW-lens-y.md on disk passes", async () => {
    await logStep({
      agent_type: "reviewer",
      status: "started",
      step_id: "review-lens-y",
      workspace,
      projectDir: process.cwd(),
    });

    mkdirSync(join(workspace, "reviews"), { recursive: true });
    writeFileSync(
      join(workspace, "reviews", "REVIEW-lens-y.md"),
      "---\nverdict: CLEAN\n---\n\n## Canon Review — Verdict: CLEAN\n",
    );

    const passResult = await logStep({
      agent_id: "rev-lens-y-01",
      agent_type: "reviewer",
      status: "completed",
      step_id: "review-lens-y",
      workspace,
      projectDir: process.cwd(),
    });
    assertOk(passResult);

    const store = getExecutionStore(workspace);
    const weakPassEvents = store.getEvents({ type: "write_receipt_weak_pass" });
    expect(weakPassEvents).toHaveLength(1);
    expect(weakPassEvents[0].payload.step_id).toBe("review-lens-y");
  });

  // Isolated workspace (fresh per-test via beforeEach) — a stray non-skeleton
  // REVIEW-*.md from a different step must not leak into this assertion; the
  // WR-02 glob fallback is not step-scoped, only content-scoped.
  it("WR-02: a skeleton reviews/REVIEW-lens-z.md on disk does NOT pass", async () => {
    await logStep({
      agent_type: "reviewer",
      status: "started",
      step_id: "review-lens-z",
      workspace,
      projectDir: process.cwd(),
    });
    mkdirSync(join(workspace, "reviews"), { recursive: true });
    writeFileSync(
      join(workspace, "reviews", "REVIEW-lens-z.md"),
      "---\nverdict: IN_PROGRESS\n---\n\n## Canon Review — Verdict: IN_PROGRESS\n",
    );

    const rejectResult = await logStep({
      agent_id: "rev-lens-z-01",
      agent_type: "reviewer",
      status: "completed",
      step_id: "review-lens-z",
      workspace,
      projectDir: process.cwd(),
    });
    expect(isToolError(rejectResult)).toBe(true);
    if (isToolError(rejectResult)) {
      expect(rejectResult.context?.receipt_missing).toEqual(["review"]);
    }
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
