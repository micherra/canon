/**
 * agent-def-real-path-integration.test.ts — Anti-regression for watch_XXXXXXXXX1.
 *
 * mutation-selection.test.ts's dc-05/dc-07/dc-08 coverage only ever fed HAND-WRITTEN
 * relative fixtures (e.g. "agents/engineer.md") into selectMutationTargets. The REAL
 * value resolve_agent_skills recorded for an agent-def artifact was absolute
 * (`resolve(pluginDir, "agents", "<name>.md")`), so classifyArtifact / isGateEligible /
 * isAgentDefTarget all silently failed on real input despite every unit test passing.
 *
 * This test drives the ACTUAL seam end-to-end with no hand-written fixtures:
 *   resolveAgentSkills (real file reads, real provenance emit)
 *     -> readProvenance (real execution-store read)
 *     -> attributeFailures (real join + byte-identity hash re-check)
 *     -> selectMutationTargets (real classify + gate-eligibility)
 *     -> evaluateCandidate's frontmatter guard (real isAgentDefTarget dispatch)
 *
 * and asserts the real emitted path classifies as an "agent" artifact, is
 * gate-eligible, and trips the frontmatter-immutability guard — the exact chain the
 * fixture-only tests could not catch.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { clearStoreCache } from "@domains/workspaces/execution-store-cache.ts";
import { resolveAgentSkills } from "@features/orchestration/tools/resolve-agent-skills.ts";
import type { ReviewViolation } from "@platform/storage/archive/archive-types.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Defensive mock: the frontmatter guard must reject BEFORE any subprocess runs. If it
// doesn't (regression), fail loudly instead of shelling out to a real eval script.
vi.mock("@platform/adapters/process-adapter.ts", () => ({
  runShell: vi.fn(),
}));

import { runShell } from "@platform/adapters/process-adapter.ts";
import { attributeFailures } from "../services/attribution-join.ts";
import { readProvenance } from "../services/attribution-provenance-source.ts";
import { classifyArtifact, selectMutationTargets } from "../services/mutation-selection.ts";
import { evaluateCandidate } from "../tools/evaluate-candidate.ts";

const mockRunShell = vi.mocked(runShell);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let pluginDir: string;
let tmpBase: string;

const AGENT_FRONTMATTER = "name: engineer\nrules:\n  - test-rule";
const AGENT_BODY = "# Role\n\nWrite code.\n";

function seedPluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "canon-real-path-plugin-"));
  mkdirSync(join(dir, "agents"));
  mkdirSync(join(dir, "rules"));
  mkdirSync(join(dir, "references"));
  mkdirSync(join(dir, "primers"));
  mkdirSync(join(dir, "templates"));
  writeFileSync(
    join(dir, "agents", "engineer.md"),
    `---\n${AGENT_FRONTMATTER}\n---\n\n${AGENT_BODY}`,
  );
  writeFileSync(join(dir, "rules", "test-rule.md"), "rule content here\n");
  return dir;
}

function seedWorkspace(baseDir: string, slug: string): string {
  const ws = join(baseDir, ".canon", "workspaces", slug);
  mkdirSync(ws, { recursive: true });
  return ws;
}

beforeEach(() => {
  pluginDir = seedPluginDir();
  tmpBase = mkdtempSync(join(tmpdir(), "canon-real-path-ws-"));
  mockRunShell.mockReset();
});

afterEach(() => {
  clearStoreCache();
  rmSync(pluginDir, { force: true, recursive: true });
  rmSync(tmpBase, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("agent-def real-path integration (watch_XXXXXXXXX1 anti-regression)", () => {
  it("classifies as 'agent', is gate-eligible, and trips the frontmatter guard — using the REAL emitted path (no hand-written fixture)", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-real-path");

    // 1. Drive the real spawn seam — this is what actually records provenance in production.
    const resolveResult = await resolveAgentSkills(
      { agent_name: "engineer" },
      pluginDir,
      undefined,
      {
        step_id: "implement",
        workspace,
      },
    );
    assertOk(resolveResult);

    // 2. Read it back through the real live-provenance reader (no synthetic payload).
    const provenance = readProvenance({ kind: "live", workspace });
    expect(provenance).toHaveLength(1);
    expect(provenance[0].agent_name).toBe("engineer");

    // 3. Real readCurrentBody seam, mirroring attribute-failure.ts / select-mutation-targets.ts
    //    exactly: honor absolute paths, otherwise join with the project root. In this build,
    //    the evolution feature's "project_dir" IS the plugin root (self-hosted evolution —
    //    see PLUGIN_ARTIFACT_ROOTS / withInjectedGuardrailCandidate, which also assume
    //    project_dir directly contains agents/, rules/, etc.).
    const readCurrentBody = (artifactPath: string): string | null => {
      try {
        const resolved = isAbsolute(artifactPath) ? artifactPath : join(pluginDir, artifactPath);
        return readFileSync(resolved, "utf-8");
      } catch {
        return null;
      }
    };

    const violation: ReviewViolation = {
      file_path: "src/foo.ts",
      message: "Violation of test-rule",
      principle_id: "test-rule",
      severity: "BLOCKING",
    };

    // 4. Real pure join — exercises both join bases (principle_id==artifact_id for the rule,
    //    code_author_agent_def for the agent-def) against the REAL recorded paths.
    const joinResult = attributeFailures({
      cliffEvents: [],
      provenance,
      readCurrentBody,
      violations: [violation],
    });

    const agentDefAttribution = joinResult.attributions.find(
      (a) => a.target_artifact.kind === "agent-def",
    );
    expect(agentDefAttribution).toBeDefined();

    // The real path must be project-root-relative, not absolute.
    expect(agentDefAttribution?.target_artifact.path).toBe("agents/engineer.md");
    // Byte-identity verification must still pass after relativization (the join(project_dir,
    // relative_path) resolution must land on the same file the hash was computed from).
    expect(agentDefAttribution?.target_artifact.hash_verified).toBe(true);
    expect(agentDefAttribution?.confidence).toBe("high");
    expect(joinResult.flagged).toHaveLength(0);

    // classifyArtifact must resolve "agent" against the REAL path, not just a fixture.
    expect(classifyArtifact(agentDefAttribution!.target_artifact.path, "agent-def")).toBe("agent");

    // 5. Real selection — builds bodies/existing from the REAL attributions and runs the
    //    same isGateEligible/classifyArtifact code path production uses.
    const bodies: Record<string, string> = {};
    const existing: Record<string, boolean> = {};
    for (const attr of joinResult.attributions) {
      const p = attr.target_artifact.path;
      existing[p] = true;
      bodies[p] = readCurrentBody(p) ?? "";
    }

    const selection = selectMutationTargets(joinResult.attributions, bodies, existing);
    const agentTarget = selection.targets.find((t) => t.target_path === "agents/engineer.md");
    expect(agentTarget).toBeDefined();
    expect(agentTarget?.artifact_class).toBe("agent");
    expect(agentTarget?.gate_eligible).toBe(true);
    expect(selection.gate_ineligible.some((g) => g.target_path === "agents/engineer.md")).toBe(
      false,
    );

    // 6. Companion assertion: isAgentDefTarget(real path) is true — the frontmatter guard
    //    fires. evaluateCandidate's guard runs BEFORE any subprocess, so a candidate with
    //    modified frontmatter must be rejected with guard_rejection, and runShell must never
    //    be invoked (proving the guard — not a real eval run — produced the verdict).
    const candidateWithChangedFrontmatter = `---\nname: engineer\nrules:\n  - test-rule\n  - agent-tdd-required\n---\n\n${AGENT_BODY}`;
    const evalResult = await evaluateCandidate({
      candidate_text: candidateWithChangedFrontmatter,
      project_dir: pluginDir,
      target_path: agentTarget!.target_path,
    });

    assertOk(evalResult);
    expect(evalResult.guard_rejection?.reason).toBe("frontmatter_modified");
    expect(evalResult.accepted).toBe(false);
    expect(mockRunShell).not.toHaveBeenCalled();
  });
});
