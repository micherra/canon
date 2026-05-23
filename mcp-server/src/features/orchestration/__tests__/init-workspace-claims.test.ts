/**
 * Tests for init-workspace preflight claim overlap check (provenance-03).
 *
 * These tests verify that runPreflightChecks reports active file claims
 * as informational warnings, gracefully handles missing claims, and
 * silently ignores claims check failures.
 */

// We need a temp dir for each test
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPreflightChecksForTest } from "../tools/init-workspace.ts";

// Scope: Tests preflight claim overlap detection — active claims reported as warnings, stale/corrupt claims ignored.

describe("init-workspace preflight — claim overlap check", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "init-workspace-claims-test-"));
    // Create .canon dir for writing claims
    mkdirSync(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("reports active claims as informational warning", async () => {
    // Write a claims.json with one active claim
    const claimsData = {
      claims: {
        "src/foo.ts": [
          {
            claimed_at: new Date().toISOString(),
            workflow: "other-workflow-slug",
          },
        ],
      },
      version: 1,
    };
    writeFileSync(join(tmpDir, ".canon", "claims.json"), JSON.stringify(claimsData), "utf-8");

    const issues = await runPreflightChecksForTest(tmpDir, "main", "");
    const claimIssue = issues.find((i) => i.includes("Active file claims"));
    expect(claimIssue).toBeDefined();
    expect(claimIssue).toContain("1 file(s)");
    expect(claimIssue).toContain("other-workflow-slug");
  });

  it("reports multiple workflows in claim warning", async () => {
    const now = new Date().toISOString();
    const claimsData = {
      claims: {
        "src/bar.ts": [{ claimed_at: now, workflow: "workflow-b" }],
        "src/foo.ts": [{ claimed_at: now, workflow: "workflow-a" }],
      },
      version: 1,
    };
    writeFileSync(join(tmpDir, ".canon", "claims.json"), JSON.stringify(claimsData), "utf-8");

    const issues = await runPreflightChecksForTest(tmpDir, "main", "");
    const claimIssue = issues.find((i) => i.includes("Active file claims"));
    expect(claimIssue).toBeDefined();
    expect(claimIssue).toContain("2 file(s)");
    // Both workflow names should be mentioned
    expect(claimIssue).toContain("workflow-a");
    expect(claimIssue).toContain("workflow-b");
  });

  it("produces no claim warning when claims.json does not exist", async () => {
    // No claims.json written — .canon/ exists but is empty
    const issues = await runPreflightChecksForTest(tmpDir, "main", "");
    const claimIssue = issues.find((i) => i.includes("Active file claims"));
    expect(claimIssue).toBeUndefined();
  });

  it("produces no claim warning when claims file is empty (no claims)", async () => {
    const claimsData = { claims: {}, version: 1 };
    writeFileSync(join(tmpDir, ".canon", "claims.json"), JSON.stringify(claimsData), "utf-8");

    const issues = await runPreflightChecksForTest(tmpDir, "main", "");
    const claimIssue = issues.find((i) => i.includes("Active file claims"));
    expect(claimIssue).toBeUndefined();
  });

  it("silently ignores stale claims (older than 24h)", async () => {
    // Create a claim from 25 hours ago
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const claimsData = {
      claims: {
        "src/stale.ts": [{ claimed_at: staleTime, workflow: "old-workflow" }],
      },
      version: 1,
    };
    writeFileSync(join(tmpDir, ".canon", "claims.json"), JSON.stringify(claimsData), "utf-8");

    const issues = await runPreflightChecksForTest(tmpDir, "main", "");
    const claimIssue = issues.find((i) => i.includes("Active file claims"));
    // Stale claims are pruned on read — no warning
    expect(claimIssue).toBeUndefined();
  });

  it("silently ignores corrupt claims.json (non-blocking)", async () => {
    // Write invalid JSON
    writeFileSync(join(tmpDir, ".canon", "claims.json"), "{ this is not valid json }", "utf-8");

    // Should not throw and should produce no claim warning
    const issues = await runPreflightChecksForTest(tmpDir, "main", "");
    const claimIssue = issues.find((i) => i.includes("Active file claims"));
    expect(claimIssue).toBeUndefined();
  });
});
