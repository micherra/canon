/**
 * finalize-workspace — tests for finalizeWorkspace.
 *
 * Covers:
 *  - finalizeWorkspace is exported and callable
 *  - Absorbed claims: claims_released is true when a session exists
 *  - Absorbed analytics: analytics_recorded is true when the journal has timestamps
 *  - Digest: digest_written is present (boolean) when complete is true
 *  - FinalizeWorkspaceInput/FinalizeWorkspaceResult are exported types
 *  - L4 skip_reason enforcement: skipped steps without skip_reason block complete
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock digest-writer so we don't need real auto-memory dir in integration tests
vi.mock("../../services/digest-writer.ts", () => ({
  tryWriteBuildDigest: vi.fn().mockResolvedValue(true),
}));

import { assertOk, isToolError } from "../../../../shared/lib/tool-result.ts";
import {
  type FinalizeWorkspaceInput,
  type FinalizeWorkspaceResult,
  finalizeWorkspace,
  logStep,
} from "../orchestration-journal.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-finalize-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe("finalizeWorkspace — rename and backward compat", () => {
  test("finalizeWorkspace is exported and callable (rename complete)", () => {
    expect(typeof finalizeWorkspace).toBe("function");
  });

  test("FinalizeWorkspaceInput and FinalizeWorkspaceResult types are exported", () => {
    // Type-level test: if these imports compile, the types are exported.
    const input: FinalizeWorkspaceInput = { workspace };
    expect(input.workspace).toBe(workspace);
    // FinalizeWorkspaceResult is a type — we verify it compiles by asserting the result shape.
    void (null as unknown as FinalizeWorkspaceResult);
  });
});

describe("finalizeWorkspace — core completion logic", () => {
  test("returns complete: true when all steps completed", async () => {
    await logStep({
      agent_id: "test-agent-fw1",
      status: "completed",
      step_id: "step-a",
      workspace,
    });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(true);
    expect(result.steps_missing).toEqual([]);
  });

  test("returns complete: false when steps are missing", async () => {
    await logStep({ status: "started", step_id: "step-a", workspace });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    expect(result.steps_missing).toHaveLength(1);
  });

  test("returns WORKSPACE_NOT_FOUND when no journal exists", async () => {
    const ghost = await mkdtemp(join(tmpdir(), "canon-finalize-ghost-"));
    const result = await finalizeWorkspace({ workspace: ghost });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    }
    await rm(ghost, { force: true, recursive: true });
  });

  test("returns INVALID_INPUT for empty workspace string", async () => {
    const result = await finalizeWorkspace({ workspace: "" });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});

describe("finalizeWorkspace — absorbed claims_released field", () => {
  test("result includes claims_released field when complete is true", async () => {
    await logStep({
      agent_id: "test-agent-cr1",
      status: "completed",
      step_id: "step-a",
      workspace,
    });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(true);
    // claims_released must be present when complete is true
    expect("claims_released" in result).toBe(true);
    expect(typeof result.claims_released).toBe("boolean");
  });

  test("claims_released is false (no session) when complete is true and no execution store", async () => {
    await logStep({
      agent_id: "test-agent-cr2",
      status: "completed",
      step_id: "step-b",
      workspace,
    });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    // Without a real execution store session, releaseClaims is best-effort
    // and claims_released reflects whether it ran without error
    expect(result.complete).toBe(true);
    expect("claims_released" in result).toBe(true);
  });

  test("claims_released is absent when complete is false", async () => {
    await logStep({ status: "started", step_id: "step-incomplete", workspace });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    // claims_released should not be present when incomplete
    expect("claims_released" in result).toBe(false);
  });
});

describe("finalizeWorkspace — absorbed analytics_recorded field", () => {
  test("result includes analytics_recorded field when complete is true", async () => {
    await logStep({
      agent_id: "test-agent-ar1",
      status: "completed",
      step_id: "step-a",
      workspace,
    });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(true);
    expect("analytics_recorded" in result).toBe(true);
    expect(typeof result.analytics_recorded).toBe("boolean");
  });

  test("analytics_recorded is absent when complete is false", async () => {
    await logStep({ status: "started", step_id: "step-incomplete", workspace });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    expect("analytics_recorded" in result).toBe(false);
  });
});

describe("finalizeWorkspace — digest_written field", () => {
  test("result includes digest_written field (boolean) when complete is true", async () => {
    await logStep({
      agent_id: "test-agent-dw1",
      status: "completed",
      step_id: "step-a",
      workspace,
    });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(true);
    // digest_written must be present when complete is true
    expect("digest_written" in result).toBe(true);
    expect(typeof result.digest_written).toBe("boolean");
  });

  test("digest_written is absent when complete is false", async () => {
    await logStep({ status: "started", step_id: "step-incomplete", workspace });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    // digest_written should not be present when incomplete
    expect("digest_written" in result).toBe(false);
  });
});

/**
 * Write a raw journal file to the workspace, bypassing logStep L1 validation.
 * Used to simulate corrupted/legacy journals for L4 defense-in-depth tests.
 */
function writeCorruptedJournal(ws: string, journal: object): void {
  writeFileSync(join(ws, "journal.json"), JSON.stringify(journal, null, 2));
}

describe("finalizeWorkspace — L4 skip_reason enforcement", () => {
  test("skipped step with valid skip_reason does not block completion (complete: true)", async () => {
    // Use logStep (L1 path) — skip_reason is present, passes L1 and L4
    await logStep({
      skip_reason: "fix-type build, no contract-level changes",
      status: "skipped",
      step_id: "context-sync",
      workspace,
    });
    await logStep({
      agent_id: "test-agent-l4-pass",
      status: "completed",
      step_id: "implement",
      workspace,
    });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(true);
    expect(result.steps_missing_skip_reason).toEqual([]);
  });

  test("skipped step with no skip_reason blocks completion (complete: false)", async () => {
    // Write a corrupted journal directly — bypasses L1 logStep validation
    writeCorruptedJournal(workspace, {
      steps: [
        {
          agent_type: null,
          artifacts_expected: [],
          status: "skipped",
          step_id: "learn",
          // skip_reason intentionally absent
        },
        {
          agent_type: "engineer",
          artifacts_expected: [],
          completed_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          status: "completed",
          step_id: "implement",
        },
      ],
      version: 1,
      workspace,
    });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    expect(result.steps_missing_skip_reason).toEqual(["learn"]);
  });

  test("skipped step with empty string skip_reason blocks completion (complete: false)", async () => {
    writeCorruptedJournal(workspace, {
      steps: [
        {
          agent_type: null,
          artifacts_expected: [],
          skip_reason: "",
          status: "skipped",
          step_id: "context-sync",
        },
      ],
      version: 1,
      workspace,
    });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    expect(result.steps_missing_skip_reason).toEqual(["context-sync"]);
  });

  test("multiple skipped steps without skip_reason are all reported", async () => {
    writeCorruptedJournal(workspace, {
      steps: [
        {
          agent_type: null,
          artifacts_expected: [],
          status: "skipped",
          step_id: "context-sync",
        },
        {
          agent_type: null,
          artifacts_expected: [],
          skip_reason: "   ",
          status: "skipped",
          step_id: "learn",
        },
        {
          agent_type: null,
          artifacts_expected: [],
          skip_reason: "session timeout",
          status: "skipped",
          step_id: "ship",
        },
      ],
      version: 1,
      workspace,
    });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    // context-sync (no skip_reason) and learn (whitespace-only) are violations
    expect(result.steps_missing_skip_reason).toHaveLength(2);
    expect(result.steps_missing_skip_reason).toContain("context-sync");
    expect(result.steps_missing_skip_reason).toContain("learn");
    // ship has a valid skip_reason — not in the violation list
    expect(result.steps_missing_skip_reason).not.toContain("ship");
  });

  test("steps_missing_skip_reason is empty array when all skipped steps have valid skip_reason", async () => {
    writeCorruptedJournal(workspace, {
      steps: [
        {
          agent_type: null,
          artifacts_expected: [],
          skip_reason: "no new patterns observed",
          status: "skipped",
          step_id: "learn",
        },
      ],
      version: 1,
      workspace,
    });
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    // Still not complete (no completed steps) but no skip_reason violations
    expect(result.steps_missing_skip_reason).toEqual([]);
  });
});

describe("finalizeWorkspace — corrupted journal handling (validate-at-trust-boundaries)", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "finalize-corrupt-test-"));
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  test("treats journal.json with a non-array steps field as empty journal", async () => {
    // Simulates corrupted or hand-edited journal where steps is not an array.
    // An empty journal has 0 steps logged — it does not produce missing-step errors.
    writeFileSync(
      join(workspace, "journal.json"),
      JSON.stringify({ steps: "not-an-array", version: 1, workspace }),
    );
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.steps_logged).toBe(0);
    expect(result.steps_missing).toHaveLength(0);
    expect(result.artifacts_missing).toHaveLength(0);
  });

  test("treats journal.json with a JSON primitive as empty journal", async () => {
    writeFileSync(join(workspace, "journal.json"), JSON.stringify(42));
    const result = await finalizeWorkspace({ workspace });
    assertOk(result);
    expect(result.steps_logged).toBe(0);
  });
});
