import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../orchestration/flow-schema.ts";
import { buildHistoryEntry, isStuck } from "../orchestration/transitions.ts";

// buildHistoryEntry — no_gate_progress

describe("buildHistoryEntry — no_gate_progress", () => {
  it("returns correct shape with provided gateOutputHash and gatePassed", () => {
    const entry = buildHistoryEntry("no_gate_progress", {
      gateOutputHash: "abc123",
      gatePassed: true,
    });
    expect(entry).toEqual({ gate_output_hash: "abc123", passed: true });
  });

  it("defaults gate_output_hash to empty string when gateOutputHash is absent", () => {
    const entry = buildHistoryEntry("no_gate_progress", {});
    expect(entry).toEqual({ gate_output_hash: "", passed: false });
  });

  it("defaults passed to false when gatePassed is absent", () => {
    const entry = buildHistoryEntry("no_gate_progress", { gateOutputHash: "hash1" });
    expect(entry).toEqual({ gate_output_hash: "hash1", passed: false });
  });

  it("correctly sets passed: false", () => {
    const entry = buildHistoryEntry("no_gate_progress", {
      gateOutputHash: "deadbeef",
      gatePassed: false,
    });
    expect(entry).toEqual({ gate_output_hash: "deadbeef", passed: false });
  });
});

// isStuck — no_gate_progress

describe("isStuck — no_gate_progress", () => {
  it("returns false when fewer than 2 entries exist (zero entries)", () => {
    expect(isStuck([], "no_gate_progress")).toBe(false);
  });

  it("returns false when fewer than 2 entries exist (one entry)", () => {
    const history: HistoryEntry[] = [{ gate_output_hash: "abc", passed: false }];
    expect(isStuck(history, "no_gate_progress")).toBe(false);
  });

  it("returns true when same gate_output_hash and passed is false", () => {
    const history: HistoryEntry[] = [
      { gate_output_hash: "hash1", passed: false },
      { gate_output_hash: "hash1", passed: false },
    ];
    expect(isStuck(history, "no_gate_progress")).toBe(true);
  });

  it("returns false when hash differs (progress was made)", () => {
    const history: HistoryEntry[] = [
      { gate_output_hash: "hash1", passed: false },
      { gate_output_hash: "hash2", passed: false },
    ];
    expect(isStuck(history, "no_gate_progress")).toBe(false);
  });

  it("returns false when current passed is true (gate now passes)", () => {
    const history: HistoryEntry[] = [
      { gate_output_hash: "hash1", passed: false },
      { gate_output_hash: "hash1", passed: true },
    ];
    expect(isStuck(history, "no_gate_progress")).toBe(false);
  });

  it("returns false when both entries have passed: true", () => {
    const history: HistoryEntry[] = [
      { gate_output_hash: "hash1", passed: true },
      { gate_output_hash: "hash1", passed: true },
    ];
    expect(isStuck(history, "no_gate_progress")).toBe(false);
  });

  it("uses only the two most recent entries (ignores earlier history)", () => {
    // The first two are the same but the last two differ
    const history: HistoryEntry[] = [
      { gate_output_hash: "hash1", passed: false },
      { gate_output_hash: "hash1", passed: false },
      { gate_output_hash: "hash2", passed: false },
    ];
    // prev = history[1] = hash1/false, curr = history[2] = hash2/false → not stuck
    expect(isStuck(history, "no_gate_progress")).toBe(false);
  });
});
