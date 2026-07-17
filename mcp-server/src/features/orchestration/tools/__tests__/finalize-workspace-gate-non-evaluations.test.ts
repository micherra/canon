/**
 * finalize-workspace-gate-non-evaluations — tests for the gate_non_evaluations
 * field (evaluator-gate Layer 2, ADR-0061).
 *
 * Split out of finalize-workspace.test.ts (sibling file, same target) to stay
 * under the noExcessiveLinesPerFile limit — mirrors the codebase's own
 * line-limit-split-into-siblings convention (see
 * ../../services/finalize-helpers.ts, extracted from orchestration-journal.ts
 * for the same reason).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Mock digest-writer so we don't need real auto-memory dir in integration tests
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../services/digest-writer.ts", () => ({
  tryWriteBuildDigest: vi.fn().mockResolvedValue(true),
}));

import { assertOk } from "../../../../shared/lib/tool-result.ts";
import { finalizeWorkspace, logStep } from "../orchestration-journal.ts";

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "finalize-gate-non-eval-"));
  projectDir = await mkdtemp(join(tmpdir(), "finalize-gate-non-eval-proj-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
  await rm(projectDir, { force: true, recursive: true });
});

describe("finalizeWorkspace — gate_non_evaluations field (evaluator-gate Layer 2, ADR-0061)", () => {
  test("empty default: no evaluator_gate outcomes at all", async () => {
    await logStep({
      agent_id: "test-agent-gate-empty",
      status: "completed",
      step_id: "implement",
      workspace,
      projectDir,
    });
    const result = await finalizeWorkspace({ projectDir, workspace });
    assertOk(result);
    expect(Array.isArray(result.gate_non_evaluations)).toBe(true);
    expect(result.gate_non_evaluations).toEqual([]);
  });

  test("dc-04 detection: PASS_parse_fallback verdict is detected", async () => {
    await logStep({
      agent_id: "test-agent-gate-fallback",
      outcome: { evaluator_gate: { verdict: "PASS_parse_fallback" } },
      status: "completed",
      step_id: "implement",
      workspace,
      projectDir,
    });
    const result = await finalizeWorkspace({ projectDir, workspace });
    assertOk(result);
    expect(result.gate_non_evaluations).toEqual([
      { reason: "PASS_parse_fallback", step_id: "implement" },
    ]);
  });

  test("dc-04 detection: tool_unavailable skip is detected", async () => {
    await logStep({
      agent_id: "test-agent-gate-unavailable",
      outcome: { evaluator_gate: { skipped: "tool_unavailable" } },
      status: "completed",
      step_id: "implement",
      workspace,
      projectDir,
    });
    const result = await finalizeWorkspace({ projectDir, workspace });
    assertOk(result);
    expect(result.gate_non_evaluations).toEqual([
      { reason: "tool_unavailable", step_id: "implement" },
    ]);
  });

  test("dc-04 detection: tool_error skip is detected", async () => {
    await logStep({
      agent_id: "test-agent-gate-error",
      outcome: { evaluator_gate: { skipped: "tool_error" } },
      status: "completed",
      step_id: "fix-1",
      workspace,
      projectDir,
    });
    const result = await finalizeWorkspace({ projectDir, workspace });
    assertOk(result);
    expect(result.gate_non_evaluations).toEqual([{ reason: "tool_error", step_id: "fix-1" }]);
  });

  test("dc-04 no false positive: a real PASS verdict never yields an entry", async () => {
    await logStep({
      agent_id: "test-agent-gate-pass",
      outcome: { evaluator_gate: { advisory: 2, verdict: "PASS" } },
      status: "completed",
      step_id: "implement",
      workspace,
      projectDir,
    });
    const result = await finalizeWorkspace({ projectDir, workspace });
    assertOk(result);
    expect(result.gate_non_evaluations).toEqual([]);
  });

  test("dc-03 loud ≠ fail-closed: a non-empty gate_non_evaluations still yields complete: true", async () => {
    await logStep({
      agent_id: "test-agent-gate-loud-not-closed",
      outcome: { evaluator_gate: { verdict: "PASS_parse_fallback" } },
      status: "completed",
      step_id: "implement",
      workspace,
      projectDir,
    });
    const result = await finalizeWorkspace({ projectDir, workspace });
    assertOk(result);
    expect(result.gate_non_evaluations).toHaveLength(1);
    expect(
      result.complete,
      "gate_non_evaluations is informational only — it must never gate `complete`, " +
        "mirroring the fail-open posture of the evaluator gate itself (ADR-0061).",
    ).toBe(true);
  });
});
