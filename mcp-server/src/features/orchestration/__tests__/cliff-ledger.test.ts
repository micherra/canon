/**
 * cliff-ledger tests (loops-phase-c-03)
 *
 * Covers:
 * - cliffSignature is stable and order-insensitive
 * - filterUnsurfaced on fresh workspace returns all steps
 * - after appendLedger, same steps return empty toSurface (surface-once AC#4)
 * - changed signature re-surfaces
 * - ENOENT ledger → empty set (fail-open)
 * - corrupt/unparseable JSON → empty set (fail-open)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLedger,
  cliffSignature,
  filterUnsurfaced,
  readLedger,
} from "../services/cliff-ledger.ts";
import { writeFileSync } from "node:fs";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-cliff-ledger-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

// ── cliffSignature ────────────────────────────────────────────────────────────

describe("cliffSignature", () => {
  it("produces a stable signature for the same inputs", () => {
    const step = { step_id: "implement", missing_artifacts: ["a.md"], partial_artifacts: [] };
    expect(cliffSignature(step)).toBe(cliffSignature(step));
  });

  it("is order-insensitive over missing_artifacts", () => {
    const s1 = cliffSignature({
      step_id: "implement",
      missing_artifacts: ["a.md", "b.md"],
      partial_artifacts: [],
    });
    const s2 = cliffSignature({
      step_id: "implement",
      missing_artifacts: ["b.md", "a.md"],
      partial_artifacts: [],
    });
    expect(s1).toBe(s2);
  });

  it("is order-insensitive over partial_artifacts", () => {
    const s1 = cliffSignature({
      step_id: "review",
      missing_artifacts: [],
      partial_artifacts: ["REVIEW.md", "DESIGN.md"],
    });
    const s2 = cliffSignature({
      step_id: "review",
      missing_artifacts: [],
      partial_artifacts: ["DESIGN.md", "REVIEW.md"],
    });
    expect(s1).toBe(s2);
  });

  it("different step_id produces different signature", () => {
    const s1 = cliffSignature({ step_id: "implement", missing_artifacts: [], partial_artifacts: [] });
    const s2 = cliffSignature({ step_id: "review", missing_artifacts: [], partial_artifacts: [] });
    expect(s1).not.toBe(s2);
  });

  it("different missing_artifacts produces different signature", () => {
    const s1 = cliffSignature({ step_id: "implement", missing_artifacts: ["a.md"], partial_artifacts: [] });
    const s2 = cliffSignature({ step_id: "implement", missing_artifacts: ["b.md"], partial_artifacts: [] });
    expect(s1).not.toBe(s2);
  });
});

// ── readLedger ────────────────────────────────────────────────────────────────

describe("readLedger", () => {
  it("returns empty set when ledger file is absent (ENOENT fail-open)", async () => {
    const result = await readLedger(workspace);
    expect(result.size).toBe(0);
  });

  it("returns empty set for corrupt/unparseable JSON (fail-open)", async () => {
    writeFileSync(join(workspace, ".cliff-surfaced.json"), "not json {{{{");
    const result = await readLedger(workspace);
    expect(result.size).toBe(0);
  });

  it("returns a set containing previously written signatures", async () => {
    writeFileSync(join(workspace, ".cliff-surfaced.json"), JSON.stringify(["sig1", "sig2"]));
    const result = await readLedger(workspace);
    expect(result.has("sig1")).toBe(true);
    expect(result.has("sig2")).toBe(true);
    expect(result.size).toBe(2);
  });
});

// ── filterUnsurfaced ─────────────────────────────────────────────────────────

describe("filterUnsurfaced", () => {
  it("returns all steps on a fresh workspace (no ledger)", async () => {
    const steps = [
      { step_id: "implement", missing_artifacts: ["a.md"], partial_artifacts: [] },
      { step_id: "review", missing_artifacts: ["REVIEW.md"], partial_artifacts: [] },
    ];
    const { toSurface, signatures } = await filterUnsurfaced(workspace, steps);
    expect(toSurface).toHaveLength(2);
    expect(signatures).toHaveLength(2);
  });

  it("returns empty toSurface after appendLedger with same steps (surface-once — AC#4)", async () => {
    const steps = [
      { step_id: "implement", missing_artifacts: ["a.md"], partial_artifacts: [] },
    ];
    // First pass: surface all
    const { signatures } = await filterUnsurfaced(workspace, steps);
    await appendLedger(workspace, signatures);

    // Second pass: same steps — already surfaced, so toSurface should be empty
    const { toSurface: toSurface2 } = await filterUnsurfaced(workspace, steps);
    expect(toSurface2).toHaveLength(0);
  });

  it("re-surfaces a step whose signature changed (new missing artifact)", async () => {
    const step1 = { step_id: "implement", missing_artifacts: ["a.md"], partial_artifacts: [] };

    // Surface and append original
    const { signatures } = await filterUnsurfaced(workspace, [step1]);
    await appendLedger(workspace, signatures);

    // Step gains a new missing artifact → new signature
    const step2 = { step_id: "implement", missing_artifacts: ["a.md", "b.md"], partial_artifacts: [] };
    const { toSurface } = await filterUnsurfaced(workspace, [step2]);
    expect(toSurface).toHaveLength(1);
    expect(toSurface[0].step_id).toBe("implement");
  });
});

// ── appendLedger ─────────────────────────────────────────────────────────────

describe("appendLedger", () => {
  it("creates the ledger file on first write", async () => {
    await appendLedger(workspace, ["sig-a"]);
    const result = await readLedger(workspace);
    expect(result.has("sig-a")).toBe(true);
  });

  it("unions with existing signatures (no duplicates)", async () => {
    await appendLedger(workspace, ["sig-a"]);
    await appendLedger(workspace, ["sig-a", "sig-b"]);
    const result = await readLedger(workspace);
    expect(result.size).toBe(2);
    expect(result.has("sig-a")).toBe(true);
    expect(result.has("sig-b")).toBe(true);
  });

  it("does not throw when called with empty array", async () => {
    await expect(appendLedger(workspace, [])).resolves.not.toThrow();
  });
});
