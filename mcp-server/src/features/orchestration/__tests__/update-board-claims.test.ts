/**
 * Tests for update-board claims integration (provenance-03).
 *
 * Verifies that:
 * - set_metadata with affected_files registers file claims
 * - set_metadata with affected_files reports overlap warnings in board metadata
 * - set_metadata without affected_files does not touch claims
 * - complete_flow releases claims for the workflow
 * - Claims operation failure is non-blocking
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateBoard } from "../tools/update-board.ts";

/** Minimal flow for tests that need a board. */
function makeMinimalFlow(): ResolvedFlow {
  return {
    description: "test",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: { implement: "Implement." },
    states: {
      implement: {
        transitions: { done: "terminal" },
        type: "single",
      },
      terminal: { type: "terminal" },
    },
  };
}

/** Set up a minimal workspace with an active execution. */
function setupWorkspace(workspace: string, slug: string): void {
  const flow = makeMinimalFlow();
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc123",
    branch: "main",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "main",
    slug,
    started: now,
    task: "test task",
    tier: "small",
  });
  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { entries: 0, status: "pending" });
  }
}

describe("update-board — set_metadata with affected_files registers claims", () => {
  let tmpDir: string;
  let workspace: string;
  const slug = "test-workspace-slug";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "update-board-claims-test-"));
    workspace = join(tmpDir, "workspace");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(tmpDir, ".canon"), { recursive: true });
    setupWorkspace(workspace, slug);
  });

  afterEach(() => {
    clearStoreCache();
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("registers file claims when set_metadata includes affected_files", async () => {
    const filePaths = ["src/foo.ts", "src/bar.ts"];
    const result = await updateBoard({
      action: "set_metadata",
      metadata: {
        affected_files: JSON.stringify(filePaths),
      },
      project_dir: tmpDir,
      workspace,
    });

    expect(result.ok).toBe(true);

    // Check that claims.json was written
    const claimsPath = join(tmpDir, ".canon", "claims.json");
    expect(existsSync(claimsPath)).toBe(true);

    const claimsData = JSON.parse(readFileSync(claimsPath, "utf-8"));
    expect(claimsData.version).toBe(1);
    expect(Object.keys(claimsData.claims)).toEqual(
      expect.arrayContaining(["src/foo.ts", "src/bar.ts"]),
    );
    // Both files claimed by our slug
    expect(claimsData.claims["src/foo.ts"][0].workflow).toBe(slug);
    expect(claimsData.claims["src/bar.ts"][0].workflow).toBe(slug);
  });

  it("stores overlap warnings in board metadata when another workflow claims same files", async () => {
    // Pre-register claims from another workflow
    const claimsData = {
      claims: {
        "src/foo.ts": [
          {
            claimed_at: new Date().toISOString(),
            workflow: "concurrent-workflow",
          },
        ],
      },
      version: 1,
    };
    writeFileSync(join(tmpDir, ".canon", "claims.json"), JSON.stringify(claimsData), "utf-8");

    const result = await updateBoard({
      action: "set_metadata",
      metadata: {
        affected_files: JSON.stringify(["src/foo.ts"]),
      },
      project_dir: tmpDir,
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The board metadata should contain claim_warnings
    const board = result.board;
    const warnings = board.metadata?.claim_warnings;
    expect(warnings).toBeDefined();
    expect(String(warnings)).toContain("concurrent-workflow");
    expect(String(warnings)).toContain("src/foo.ts");
  });

  it("does not touch claims when set_metadata has no affected_files", async () => {
    const result = await updateBoard({
      action: "set_metadata",
      metadata: { some_key: "some_value" },
      project_dir: tmpDir,
      workspace,
    });

    expect(result.ok).toBe(true);

    // claims.json should NOT be created
    const claimsPath = join(tmpDir, ".canon", "claims.json");
    expect(existsSync(claimsPath)).toBe(false);
  });

  it("is non-blocking when affected_files JSON is malformed", async () => {
    // Should not throw or fail the tool result
    const result = await updateBoard({
      action: "set_metadata",
      metadata: { affected_files: "not-valid-json[" },
      project_dir: tmpDir,
      workspace,
    });

    // Tool should succeed despite the malformed JSON
    expect(result.ok).toBe(true);
  });
});

describe("update-board — complete_flow releases claims", () => {
  let tmpDir: string;
  let workspace: string;
  const slug = "test-workspace-slug";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "update-board-complete-test-"));
    workspace = join(tmpDir, "workspace");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(tmpDir, ".canon"), { recursive: true });
    setupWorkspace(workspace, slug);
  });

  afterEach(() => {
    clearStoreCache();
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("releases claims for the workflow on complete_flow", async () => {
    const now = new Date().toISOString();
    // Pre-register claims for the workspace's slug
    const claimsData = {
      claims: {
        "src/bar.ts": [
          { claimed_at: now, workflow: slug },
          { claimed_at: now, workflow: "other-workflow" },
        ],
        "src/foo.ts": [{ claimed_at: now, workflow: slug }],
      },
      version: 1,
    };
    writeFileSync(join(tmpDir, ".canon", "claims.json"), JSON.stringify(claimsData), "utf-8");

    const result = await updateBoard({
      action: "complete_flow",
      project_dir: tmpDir,
      workspace,
    });

    expect(result.ok).toBe(true);

    // After complete_flow, slug claims should be gone
    const claimsPath = join(tmpDir, ".canon", "claims.json");
    const updatedClaims = JSON.parse(readFileSync(claimsPath, "utf-8"));

    // src/foo.ts had only slug claim — should be removed entirely
    expect(updatedClaims.claims["src/foo.ts"]).toBeUndefined();

    // src/bar.ts had slug + other-workflow — only other-workflow remains
    expect(updatedClaims.claims["src/bar.ts"]).toBeDefined();
    expect(updatedClaims.claims["src/bar.ts"]).toHaveLength(1);
    expect(updatedClaims.claims["src/bar.ts"][0].workflow).toBe("other-workflow");
  });

  it("complete_flow is non-blocking even when no claims exist", async () => {
    // No claims.json — releaseClaims is a no-op
    const result = await updateBoard({
      action: "complete_flow",
      project_dir: tmpDir,
      workspace,
    });

    expect(result.ok).toBe(true);
  });
});
