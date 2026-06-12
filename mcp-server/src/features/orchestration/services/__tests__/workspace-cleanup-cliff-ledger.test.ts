/**
 * workspace-cleanup — cliff ledger removal tests (loops-phase-c-03)
 *
 * Tests cover:
 * - tryRemoveCliffLedger removes .cliff-surfaced.json when present
 * - tryRemoveCliffLedger does NOT error when ledger is absent (ENOENT is silently swallowed)
 */

import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryRemoveCliffLedger } from "../workspace-cleanup.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-cliff-cleanup-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe("tryRemoveCliffLedger (loops-phase-c-03)", () => {
  it("removes .cliff-surfaced.json when present", async () => {
    const ledgerPath = join(workspace, ".cliff-surfaced.json");
    writeFileSync(ledgerPath, JSON.stringify(["sig-a"]), "utf-8");
    expect(existsSync(ledgerPath)).toBe(true);

    await tryRemoveCliffLedger(workspace);

    expect(existsSync(ledgerPath)).toBe(false);
  });

  it("does not throw when ledger is absent (ENOENT is silently swallowed)", async () => {
    // Ledger was never created — should not error
    await expect(tryRemoveCliffLedger(workspace)).resolves.not.toThrow();
  });
});
