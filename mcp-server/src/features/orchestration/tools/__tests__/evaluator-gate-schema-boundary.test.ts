/**
 * evaluator-gate-schema-boundary — closes the gap the engineer's own
 * DONE_WITH_CONCERNS finding identified after evalfix-01 (commit 10ad363b):
 * Layer 2 (gate_non_evaluations[], ADR-0058) is production-inert
 * because register-journal.ts's stepOutcomeSchema silently stripped the
 * evaluator_gate outcome key at the MCP boundary.
 *
 * finalize-workspace-gate-non-evaluations.test.ts (sibling file, same
 * target) proves the compute logic (computeGateNonEvaluations) is correct,
 * but it calls logStep() directly with an already-typed outcome object —
 * it never exercises the zod schema the MCP SDK parses a REAL log_step/
 * batch_log_steps call through. A schema that strips evaluator_gate would
 * make every test in that file pass while the real tool call silently
 * dropped the key in production. This file closes exactly that gap: it
 * parses through stepEntrySchema (exported from register-journal.ts for
 * boundary testing, same convention as reconcileWorkspaceInputSchema —
 * see reconcile-workspace.test.ts for the precedent), THEN feeds the
 * PARSED result into logStep/finalizeWorkspace, proving evaluator_gate
 * survives the real MCP input-parse boundary end-to-end.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Mock digest-writer so we don't need real auto-memory dir in integration tests
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../services/digest-writer.ts", () => ({
  tryWriteBuildDigest: vi.fn().mockResolvedValue(true),
}));

import { stepEntrySchema } from "@app/register-journal.ts";
import { assertOk } from "../../../../shared/lib/tool-result.ts";
import { finalizeWorkspace, logStep } from "../orchestration-journal.ts";

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "eval-gate-boundary-"));
  projectDir = await mkdtemp(join(tmpdir(), "eval-gate-boundary-proj-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
  await rm(projectDir, { force: true, recursive: true });
});

describe("evaluator_gate survives the real stepEntrySchema MCP boundary (ADR-0058 Layer 2 closure)", () => {
  test("a skip-form outcome parses through stepEntrySchema and reaches gate_non_evaluations end-to-end", async () => {
    const rawInput = {
      agent_id: "test-agent-boundary-skip",
      outcome: { evaluator_gate: { skipped: "tool_unavailable" } },
      status: "completed",
      step_id: "implement",
    };

    // Parse through the ACTUAL registered zod schema — the same schema the
    // MCP SDK applies to a real batch_log_steps/log_step call. A schema
    // that strips evaluator_gate fails right here, before logStep ever runs.
    const parsed = stepEntrySchema.parse(rawInput);
    expect(
      parsed.outcome?.evaluator_gate,
      "stepEntrySchema stripped the evaluator_gate key at the MCP input-parse " +
        "boundary — Layer 2 (gate_non_evaluations) is production-inert even " +
        "though logStep()-direct unit tests pass.",
    ).toEqual({ skipped: "tool_unavailable" });

    await logStep({ ...parsed, projectDir, workspace });

    const result = await finalizeWorkspace({ projectDir, workspace });
    assertOk(result);
    expect(result.gate_non_evaluations).toEqual([
      { reason: "tool_unavailable", step_id: "implement" },
    ]);
  });

  test("a genuine PASS verdict parsed through the same boundary yields an empty gate_non_evaluations (no false positive)", async () => {
    const rawInput = {
      agent_id: "test-agent-boundary-pass",
      outcome: { evaluator_gate: { advisory: 2, verdict: "PASS" } },
      status: "completed",
      step_id: "implement",
    };

    const parsed = stepEntrySchema.parse(rawInput);
    expect(parsed.outcome?.evaluator_gate).toEqual({ advisory: 2, verdict: "PASS" });

    await logStep({ ...parsed, projectDir, workspace });

    const result = await finalizeWorkspace({ projectDir, workspace });
    assertOk(result);
    expect(result.gate_non_evaluations).toEqual([]);
  });
});
