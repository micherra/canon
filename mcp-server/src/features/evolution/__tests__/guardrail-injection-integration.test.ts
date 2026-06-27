/**
 * guardrail-injection-integration.test.ts — OFFLINE routing integration test.
 *
 * Verifies that evaluateCandidate auto-selects the injection mode from target_path:
 * - guardrail-corpus paths (rules/, primers/, agents/, etc.) →
 *     withInjectedGuardrailCandidate; the runShell command includes EVAL_PLUGIN_DIR=
 * - eval-surface paths (skills/canon/evals/) →
 *     withInjectedCandidate; the runShell command does NOT include EVAL_PLUGIN_DIR=
 *
 * OFFLINE: @platform/adapters/process-adapter is mocked so NO real claude invocations
 * happen and NO eval tokens are spent. Injection functions run for real (cheap fs ops).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessResult } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the process adapter BEFORE importing the tool under test.
// Vitest hoists vi.mock() calls above all imports automatically.
vi.mock("@platform/adapters/process-adapter.ts", () => ({
  runShell: vi.fn(),
}));

import { runShell } from "@platform/adapters/process-adapter.ts";
import { evaluateCandidate } from "../tools/evaluate-candidate.ts";

const mockRunShell = vi.mocked(runShell);

// A fake ProcessResult that looks like a successful 1-of-1 eval run.
// parseSummary will parse this into { total: 1, passed: 1, failed: 0 }.
function makeOkResult(
  stdout = "Total: 1 | Passed: 1 | Failed: 0 | Errors: 0 | Skipped: 0",
): ProcessResult {
  return { duration_ms: 1, exitCode: 0, ok: true, stderr: "", stdout, timedOut: false };
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe("evaluateCandidate injection-mode routing (offline, no eval tokens)", () => {
  let projectDir: string;

  beforeEach(async () => {
    // Create a minimal project dir with just the eval surface so withInjectedCandidate
    // can copy it (withInjectedGuardrailCandidate copies the skills/ root which covers this).
    const { mkdtemp } = await import("node:fs/promises");
    projectDir = await mkdtemp(join(tmpdir(), "canon-routing-test-"));
    await mkdir(join(projectDir, "skills", "canon", "evals"), { recursive: true });
    await writeFile(
      join(projectDir, "skills", "canon", "evals", "run-evals.sh"),
      "#!/bin/bash\necho test",
    );
    // Also create a minimal rules/ dir so the guardrail injection has something to copy.
    await mkdir(join(projectDir, "rules"), { recursive: true });
    await writeFile(join(projectDir, "rules", "placeholder.md"), "# placeholder");

    vi.clearAllMocks();
    // Default: all runShell calls return a successful result.
    mockRunShell.mockReturnValue(makeOkResult());
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(projectDir, { recursive: true, force: true });
  });

  // ── Guardrail route ──────────────────────────────────────────────────────────

  describe("guardrail-corpus target (rules/agent-foo.md)", () => {
    it("evaluateCandidate succeeds (result.ok = true)", async () => {
      const result = await evaluateCandidate({
        candidate_text: "# guardrail candidate",
        project_dir: projectDir,
        target_path: "rules/agent-foo.md",
      });

      expect(result.ok).toBe(true);
    });

    it("every runShell call includes EVAL_PLUGIN_DIR= (pluginDir threaded through)", async () => {
      await evaluateCandidate({
        candidate_text: "# guardrail candidate",
        project_dir: projectDir,
        target_path: "rules/agent-foo.md",
      });

      const calls = mockRunShell.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      for (const [command] of calls) {
        expect(command).toMatch(/EVAL_PLUGIN_DIR=/);
      }
    });

    it("the EVAL_PLUGIN_DIR value is a non-empty path string", async () => {
      await evaluateCandidate({
        candidate_text: "# guardrail candidate",
        project_dir: projectDir,
        target_path: "rules/agent-foo.md",
      });

      const calls = mockRunShell.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      // Extract EVAL_PLUGIN_DIR value from first command (all should match).
      const [firstCommand] = calls[0];
      const match = firstCommand.match(/EVAL_PLUGIN_DIR="([^"]+)"/);
      expect(match).not.toBeNull();
      expect(match![1].length).toBeGreaterThan(0);
    });
  });

  // ── Eval-surface route ───────────────────────────────────────────────────────

  describe("eval-surface target (skills/canon/evals/eval-set.json)", () => {
    it("evaluateCandidate succeeds (result.ok = true)", async () => {
      const result = await evaluateCandidate({
        candidate_text: "# eval-surface candidate",
        project_dir: projectDir,
        target_path: "skills/canon/evals/eval-set.json",
      });

      expect(result.ok).toBe(true);
    });

    it("NO runShell call includes EVAL_PLUGIN_DIR= (eval-surface uses no pluginDir)", async () => {
      await evaluateCandidate({
        candidate_text: "# eval-surface candidate",
        project_dir: projectDir,
        target_path: "skills/canon/evals/eval-set.json",
      });

      const calls = mockRunShell.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      for (const [command] of calls) {
        expect(command).not.toMatch(/EVAL_PLUGIN_DIR=/);
      }
    });
  });
});
