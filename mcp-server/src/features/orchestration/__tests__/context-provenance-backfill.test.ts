/**
 * Tests for context-provenance-backfill.ts and its integration with logStep/batchLogSteps.
 *
 * Covers:
 * - backfillContextProvenanceAgentId appends a context_provenance_agent_id event with
 *   the correct payload and correlation_id
 * - Fail-open: a non-existent workspace path does NOT throw
 * - logStep completed + agent_id writes a backfill event
 * - logStep completed without agent_id (inline-fix) writes NO backfill event
 * - batchLogSteps completed entry with agent_id writes a backfill event
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { afterEach, describe, expect, it } from "vitest";
import { backfillContextProvenanceAgentId } from "../services/context-provenance-backfill.ts";
import { batchLogSteps, logStep } from "../tools/orchestration-journal.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "cpb-test-"));
  tmpDirs.push(dir);
  return dir;
}

function setupWorkspace(workspace: string): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: "implement",
    entry: "implement",
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });
}

/** Write a minimal journal.json so logStep can read it without error. */
async function writeEmptyJournal(workspace: string): Promise<void> {
  const journal = { steps: [], version: 1, workspace };
  writeFileSync(join(workspace, "journal.json"), JSON.stringify(journal));
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Unit tests: backfillContextProvenanceAgentId
// ---------------------------------------------------------------------------

describe("backfillContextProvenanceAgentId — happy path", () => {
  it("appends a context_provenance_agent_id event with correct payload and correlation_id", () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace);

    backfillContextProvenanceAgentId(workspace, "implement", "agent-abc-123");

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance_agent_id");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("context_provenance_agent_id");
    expect(events[0].payload).toMatchObject({
      agent_id: "agent-abc-123",
      step_id: "implement",
    });
    // correlation_id must equal step_id (used by run-summary join)
    expect(events[0].correlation_id).toBe("implement");
  });
});

describe("backfillContextProvenanceAgentId — fail-open: non-existent workspace", () => {
  it("does not throw when workspace does not exist", () => {
    // No setupWorkspace call — store will fail to open or append
    expect(() => {
      backfillContextProvenanceAgentId(
        "/tmp/does-not-exist-cpb-test-xyz-99999",
        "step-id",
        "agent-xyz",
      );
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: logStep wires the backfill
// ---------------------------------------------------------------------------

describe("logStep — completed + agent_id writes backfill event", () => {
  it("appends context_provenance_agent_id event after completing a step with agent_id", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace);
    await writeEmptyJournal(workspace);
    // Create artifacts/ dir so artifact scan doesn't fail
    await mkdir(join(workspace, "artifacts"), { recursive: true });

    // No agent_type — this test exercises the backfill wiring only, not the
    // write-receipt gate (a mapped agent_type like "engineer" would reject
    // this completion since the fixture writes no artifact/receipt).
    const result = await logStep({
      agent_id: "agent-log-step-001",
      artifacts_expected: [],
      projectDir: workspace,
      status: "completed",
      step_id: "implement",
      workspace,
    });

    expect(result.ok).toBe(true);

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance_agent_id");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      agent_id: "agent-log-step-001",
      step_id: "implement",
    });
  });
});

describe("logStep — completed WITHOUT agent_id (inline-fix) writes NO backfill event", () => {
  it("does not append context_provenance_agent_id when agent_id is absent", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace);
    await writeEmptyJournal(workspace);
    await mkdir(join(workspace, "artifacts"), { recursive: true });

    const result = await logStep({
      agent_type: "engineer",
      artifacts_expected: [],
      projectDir: workspace,
      status: "completed",
      step_id: "inline-fix",
      workspace,
    });

    expect(result.ok).toBe(true);

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance_agent_id");
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: batchLogSteps wires the backfill
// ---------------------------------------------------------------------------

/**
 * Regression test for Codex P2 bug (2026-06-24):
 *
 * When batchLogSteps processes a batch where an earlier completed entry carries
 * an agent_id and a LATER entry causes rejection (e.g. empty step_id), the
 * back-fill must NOT be written — the batch did not commit.
 *
 * Before the fix, backfillContextProvenanceAgentId was called inside processEntries
 * before the rejection short-circuit, leaving a stale event in the execution store.
 * After the fix, back-fills are only fired after the journal write succeeds.
 */
describe("batchLogSteps — rejected batch writes ZERO back-fill events", () => {
  it("does not append context_provenance_agent_id when batch is rejected by a later invalid entry", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace);
    await writeEmptyJournal(workspace);
    await mkdir(join(workspace, "artifacts"), { recursive: true });

    // First entry is valid (completed with agent_id).
    // Second entry has an empty step_id → causes the entire batch to be rejected.
    const result = await batchLogSteps({
      projectDir: workspace,
      steps: [
        {
          agent_id: "agent-rejected-batch-001",
          agent_type: "engineer",
          artifacts_expected: [],
          status: "completed",
          step_id: "implement",
        },
        {
          agent_type: "engineer",
          status: "completed",
          step_id: "", // invalid — empty step_id causes batch rejection
        },
      ],
      workspace,
    });

    // The batch must have been rejected.
    expect(result.ok).toBe(false);

    // CRITICAL: no back-fill event must have been written for the first entry,
    // because the batch was rejected before the journal write.
    const store = getExecutionStore(workspace);
    const backfills = store.getEventsByType("context_provenance_agent_id");
    expect(backfills).toHaveLength(0);
  });
});

describe("batchLogSteps — completed entry with agent_id writes backfill event", () => {
  it("appends context_provenance_agent_id event for each completed entry with agent_id", async () => {
    const workspace = makeTmpWorkspace();
    setupWorkspace(workspace);
    await writeEmptyJournal(workspace);
    await mkdir(join(workspace, "artifacts"), { recursive: true });

    // No agent_type on the completed entry — same rationale as the logStep
    // test above (this exercises backfill wiring, not the write-receipt gate).
    const result = await batchLogSteps({
      projectDir: workspace,
      steps: [
        {
          agent_id: "agent-batch-001",
          artifacts_expected: [],
          status: "completed",
          step_id: "implement",
        },
        // A started step with no agent_id — no backfill expected
        {
          agent_type: "engineer",
          status: "started",
          step_id: "verify",
        },
      ],
      workspace,
    });

    expect(result.ok).toBe(true);

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance_agent_id");
    // Only the completed+agent_id entry triggers a backfill
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      agent_id: "agent-batch-001",
      step_id: "implement",
    });
  });
});
