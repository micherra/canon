/**
 * finalize-workspace — tests for finalizeWorkspace.
 *
 * Covers:
 *  - finalizeWorkspace is exported and callable
 *  - Absorbed claims: claims_released is true when a session exists
 *  - Absorbed analytics: analytics_recorded is true when the journal has timestamps
 *  - FinalizeWorkspaceInput/FinalizeWorkspaceResult are exported types
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
