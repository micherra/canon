/**
 * End-to-end integration test for the three-piece context-provenance chain:
 *   1. EMIT  — resolveAgentSkills writes a context_provenance event (agent_id: null)
 *   2. BACK-FILL — logStep completed with agent_id writes a context_provenance_agent_id event
 *   3. JOIN  — buildRunSummary reads both event types and joins agent_id by step_id
 *
 * Each piece has its own unit tests. This file proves the cross-piece chain works end-to-end
 * using the REAL functions — no hand-seeded events, no mocks of the store.
 *
 * PRD ACs covered:
 *   AC #1 — context_provenance event emitted from resolveAgentSkills (with step_id option)
 *   AC #4 — agent_id back-filled by logStep completion
 *   AC #5 — RunSummary carries context_provenance with joined agent_id
 *
 * Sad-path ACs also covered:
 *   - No back-fill (logStep without agent_id) → summary entry.agent_id === null
 *   - No step_id in resolveAgentSkills → event still written, surfaces with step_id null + agent_id null
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { logStep } from "@features/orchestration/tools/orchestration-journal.ts";
import { resolveAgentSkills } from "@features/orchestration/tools/resolve-agent-skills.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { buildRunSummary } from "../run-summary-builder.ts";

// ---------------------------------------------------------------------------
// Helpers — mirror the patterns from the unit test files in this dir
// ---------------------------------------------------------------------------

function seedPluginDir(): string {
  const pluginDir = mkdtempSync(join(tmpdir(), "cp-e2e-plugin-"));
  mkdirSync(join(pluginDir, "agents"));
  mkdirSync(join(pluginDir, "rules"));
  mkdirSync(join(pluginDir, "references"));
  mkdirSync(join(pluginDir, "primers"));
  mkdirSync(join(pluginDir, "templates"));

  // Write a small rule (below disclosure threshold) so real content_hash & span fire
  writeFileSync(
    join(pluginDir, "rules", "agent-tdd.md"),
    "---\nid: agent-tdd\ntitle: TDD Rule\nseverity: rule\n---\n\nAlways write tests first.\n",
  );

  // Engineer agent referencing the rule
  writeFileSync(
    join(pluginDir, "agents", "engineer.md"),
    "---\nname: engineer\nrules:\n  - agent-tdd\n---\n\nEngineer agent body.\n",
  );

  return pluginDir;
}

function seedWorkspace(base: string, slug: string): string {
  const ws = join(base, ".canon", "workspaces", slug);
  mkdirSync(ws, { recursive: true });
  return ws;
}

function initStore(workspace: string): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc123",
    branch: "canon/e2e-test",
    created: now,
    current_state: "implement",
    entry: "implement",
    flow: "e2e-test-flow",
    flow_name: "e2e-test-flow",
    last_updated: now,
    sanitized: "e2e-test",
    slug: "e2e-test",
    started: now,
    task: "e2e integration test",
    tier: "small",
  });
}

async function writeEmptyJournal(workspace: string): Promise<void> {
  const journal = { steps: [], version: 1, workspace };
  writeFileSync(join(workspace, "journal.json"), JSON.stringify(journal));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let pluginDir: string;
let tmpBase: string;

// Use fresh temp dirs per test — reset in afterEach
function setup(): { pluginDir: string; tmpBase: string } {
  const pd = seedPluginDir();
  const tb = mkdtempSync(join(tmpdir(), "cp-e2e-base-"));
  return { pluginDir: pd, tmpBase: tb };
}

afterEach(() => {
  clearStoreCache();
  // Clean up all temp dirs created during tests
  if (pluginDir) {
    rmSync(pluginDir, { force: true, recursive: true });
    pluginDir = "";
  }
  if (tmpBase) {
    rmSync(tmpBase, { force: true, recursive: true });
    tmpBase = "";
  }
});

// ---------------------------------------------------------------------------
// Happy-path end-to-end chain: EMIT → BACK-FILL → JOIN
// ---------------------------------------------------------------------------

describe("end-to-end provenance chain: emit → back-fill → summary join", () => {
  it("RunSummary.context_provenance contains one entry with the back-filled agent_id", async () => {
    // Setup
    ({ pluginDir, tmpBase } = setup());
    const workspace = seedWorkspace(tmpBase, "e2e-happy-01");
    initStore(workspace);
    await writeEmptyJournal(workspace);
    await mkdir(join(workspace, "artifacts"), { recursive: true });

    const STEP_ID = "implement";
    const AGENT_ID = "agent-e2e-happy-001";

    // PIECE 1: EMIT — resolveAgentSkills writes the context_provenance event
    const resolved = await resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
      workspace,
      step_id: STEP_ID,
    });
    assertOk(resolved);
    expect(resolved.agent_name).toBe("engineer");

    // Verify the event landed in the store (contract: exactly one event)
    const store = getExecutionStore(workspace);
    const provenanceEvents = store.getEventsByType("context_provenance");
    expect(provenanceEvents).toHaveLength(1);
    const emittedRecord = provenanceEvents[0].payload as {
      step_id: string | null;
      agent_id: null;
      assembled_artifacts: Array<{ id: string; content_hash: string }>;
    };
    expect(emittedRecord.step_id).toBe(STEP_ID);
    expect(emittedRecord.agent_id).toBeNull(); // not yet back-filled
    expect(emittedRecord.assembled_artifacts).toHaveLength(1);
    expect(emittedRecord.assembled_artifacts[0].id).toBe("agent-tdd");

    // PIECE 2: BACK-FILL — logStep completed with agent_id writes back-fill event
    const logResult = await logStep({
      agent_id: AGENT_ID,
      agent_type: "engineer",
      artifacts_expected: [],
      projectDir: workspace,
      status: "completed",
      step_id: STEP_ID,
      workspace,
    });
    expect(logResult.ok).toBe(true);

    // Verify back-fill event landed
    const backfills = store.getEventsByType("context_provenance_agent_id");
    expect(backfills).toHaveLength(1);
    expect(backfills[0].payload).toMatchObject({
      agent_id: AGENT_ID,
      step_id: STEP_ID,
    });

    // PIECE 3: JOIN — buildRunSummary reads both events and joins agent_id
    const summary = buildRunSummary({
      archiveId: "test-archive-e2e",
      metadata: {
        archivedAt: new Date().toISOString(),
        branch: "canon/e2e-test",
        flow: "e2e-test-flow",
        task: "e2e integration test",
        tier: "small",
      },
      slug: "e2e-test",
      workspacePath: workspace,
    });

    // The join must have succeeded: exactly one entry with the real agent_id
    expect(summary.context_provenance).toBeDefined();
    expect(summary.context_provenance).toHaveLength(1);

    const entry = summary.context_provenance![0];
    expect(entry.step_id).toBe(STEP_ID);
    expect(entry.agent_id).toBe(AGENT_ID); // ← the key assertion: cross-piece join worked
    expect(entry.agent_name).toBe("engineer");

    // artifact_count > 0 (at least the "agent-tdd" rule was assembled)
    expect(entry.artifact_count).toBeGreaterThan(0);
    expect(entry.artifacts).toHaveLength(entry.artifact_count);

    // No content field on any artifact (AC #7: hashes+spans only)
    for (const artifact of entry.artifacts) {
      expect(artifact).not.toHaveProperty("content");
      expect(artifact).toHaveProperty("content_hash");
    }
  });
});

// ---------------------------------------------------------------------------
// Sad path 1: No back-fill (logStep without agent_id) → agent_id stays null
// ---------------------------------------------------------------------------

describe("sad path: no back-fill when logStep has no agent_id", () => {
  it("summary entry agent_id is null when step completed without agent_id (inline-fix exempt step)", async () => {
    ({ pluginDir, tmpBase } = setup());
    const workspace = seedWorkspace(tmpBase, "e2e-no-backfill-01");
    initStore(workspace);
    await writeEmptyJournal(workspace);
    await mkdir(join(workspace, "artifacts"), { recursive: true });

    // EMIT with a real step_id (the provenance event for this step)
    const STEP_ID_PROVISION = "implement";
    const resolved = await resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
      workspace,
      step_id: STEP_ID_PROVISION,
    });
    assertOk(resolved);

    // Complete the INLINE-FIX step (step_id === "inline-fix" is the only path logStep
    // allows completion without agent_id — this is the canonical "no back-fill" scenario).
    // The backfill test in context-provenance-backfill.test.ts uses this same pattern.
    const logResult = await logStep({
      agent_type: "engineer",
      artifacts_expected: [],
      projectDir: workspace,
      status: "completed",
      step_id: "inline-fix", // exempt from agent_id requirement
      workspace,
    });
    expect(logResult.ok).toBe(true);

    // No back-fill event was written (inline-fix has no agent_id)
    const store = getExecutionStore(workspace);
    const backfills = store.getEventsByType("context_provenance_agent_id");
    expect(backfills).toHaveLength(0);

    // JOIN — the original provisioned provenance event has step_id "implement" and no back-fill
    const summary = buildRunSummary({
      archiveId: "no-backfill-archive",
      metadata: {
        archivedAt: new Date().toISOString(),
        branch: "canon/e2e-test",
        flow: "e2e-test-flow",
        task: "no-backfill test",
        tier: "small",
      },
      slug: "e2e-test",
      workspacePath: workspace,
    });

    expect(summary.context_provenance).toHaveLength(1);
    expect(summary.context_provenance![0].agent_id).toBeNull(); // no back-fill → null
    expect(summary.context_provenance![0].step_id).toBe(STEP_ID_PROVISION);
  });
});

// ---------------------------------------------------------------------------
// Sad path 2: resolveAgentSkills WITHOUT step_id → event still written,
//   step_id null in event and summary, agent_id null (fail-open, degraded)
// ---------------------------------------------------------------------------

describe("sad path: no step_id in resolveAgentSkills → degraded provenance, not blocked", () => {
  it("context_provenance event still written when step_id absent, surfaces with null step_id and agent_id", async () => {
    ({ pluginDir, tmpBase } = setup());
    const workspace = seedWorkspace(tmpBase, "e2e-no-stepid-01");
    initStore(workspace);

    // EMIT without step_id (fail-open path per AC #3)
    const resolved = await resolveAgentSkills(
      { agent_name: "engineer" },
      pluginDir,
      undefined,
      { workspace }, // step_id intentionally omitted
    );
    assertOk(resolved);

    // The resolve call must have completed normally
    expect(resolved.agent_name).toBe("engineer");
    expect(resolved.skills).toHaveLength(1);

    // A context_provenance event MUST still be written (fail-open, not fail-blocked)
    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    expect(events).toHaveLength(1);

    const record = events[0].payload as { step_id: string | null };
    expect(record.step_id).toBeNull(); // no step_id → null join key

    // JOIN — buildRunSummary surfaces the degraded entry
    const summary = buildRunSummary({
      archiveId: "no-stepid-archive",
      metadata: {
        archivedAt: new Date().toISOString(),
        branch: "canon/e2e-test",
        flow: "e2e-test-flow",
        task: "no-stepid test",
        tier: "small",
      },
      slug: "e2e-test",
      workspacePath: workspace,
    });

    // Still one entry (degraded, not absent)
    expect(summary.context_provenance).toHaveLength(1);
    expect(summary.context_provenance![0].step_id).toBeNull();
    expect(summary.context_provenance![0].agent_id).toBeNull();

    // artifact_count is still meaningful (the artifacts were resolved)
    expect(summary.context_provenance![0].artifact_count).toBeGreaterThan(0);
  });
});
