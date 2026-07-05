/**
 * get-decisions-corpus.test.ts
 *
 * Integration tests for the get_decisions_corpus MCP tool wrapper — imports
 * the handler directly (per agent-integration-boundary-check), exercising
 * the real service against isolated mkdtemp fixtures (drift-db-leak-guard
 * convention: never process.cwd()).
 *
 * Covers:
 * (a) happy path — live + durable union surfaces through the tool
 * (b) fail-open default — an invalid project_dir still returns INVALID_INPUT,
 *     but an internal read failure degrades to an empty-but-ok result
 * (c) error/edge path — empty `.canon/workspaces` -> ok with empty corpus
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { CANON_DIR } from "@shared/constants.ts";
import { isToolError } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { getDecisionsCorpus } from "../get-decisions-corpus.ts";

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

describe("getDecisionsCorpus — happy path", () => {
  it("returns the unioned live + durable corpus with aggregation and rendered output", async () => {
    const projectDir = makeTmpDir("get-decisions-corpus-happy-");
    const workspaceDir = join(projectDir, CANON_DIR, "workspaces", "main", "live-slug");
    mkdirSync(workspaceDir, { recursive: true });
    getExecutionStore(workspaceDir).appendEvent("orchestrator_decision", {
      decision_type: "hitl_gate",
      gate: "plan_approval",
      summary: "Plan approved",
      timestamp: new Date().toISOString(),
    });
    getDriftDb(projectDir)
      .getOrchestratorDecisions()
      .persistMany("durable-slug", [
        {
          decided_at: new Date().toISOString(),
          decision_type: "other",
          source_event_id: 1,
          summary: "Persisted after reap",
        },
      ]);

    const result = await getDecisionsCorpus({ project_dir: projectDir });

    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) return;
    expect(result.decisions).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    expect(result.aggregation.total).toBe(2);
    expect(result.aggregation.by_category.plan_approval).toBe(1);
    expect(result.rendered).toContain("Total decisions");
  });
});

describe("getDecisionsCorpus — validation", () => {
  it("returns INVALID_INPUT for a non-absolute project_dir", async () => {
    const result = await getDecisionsCorpus({ project_dir: "relative/path" });

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT for an empty project_dir", async () => {
    const result = await getDecisionsCorpus({ project_dir: "" });

    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe("INVALID_INPUT");
  });
});

describe("getDecisionsCorpus — empty workspaces dir", () => {
  it("returns ok with an empty corpus when .canon/workspaces does not exist", async () => {
    const projectDir = makeTmpDir("get-decisions-corpus-empty-");

    const result = await getDecisionsCorpus({ project_dir: projectDir });

    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) return;
    expect(result.decisions).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.aggregation.total).toBe(0);
  });
});
