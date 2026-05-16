/**
 * dag-layout.test.ts
 *
 * Unit tests for the computeDagLayout pure function.
 * Tests cover TDD-first: tests written before implementation.
 */

import { describe, expect, it } from "vitest";
import { computeDagLayout } from "../dag-layout.ts";

describe("computeDagLayout()", () => {
  it("returns an empty map for empty input", () => {
    const result = computeDagLayout([]);
    expect(result.size).toBe(0);
  });

  it("places a single node with no edges at position (0, 0)", () => {
    const result = computeDagLayout([{ depends_on: [], id: "A" }]);
    expect(result.size).toBe(1);
    const pos = result.get("A");
    expect(pos).toBeDefined();
    expect(pos!.x).toBe(0);
    expect(pos!.y).toBe(0);
  });

  it("linear chain (A→B→C) produces three distinct Y layers", () => {
    const nodes = [
      { depends_on: [], id: "A" },
      { depends_on: ["A"], id: "B" },
      { depends_on: ["B"], id: "C" },
    ];
    const result = computeDagLayout(nodes);
    expect(result.size).toBe(3);

    const posA = result.get("A")!;
    const posB = result.get("B")!;
    const posC = result.get("C")!;

    // Layers should be strictly increasing in Y
    expect(posA.y).toBeLessThan(posB.y);
    expect(posB.y).toBeLessThan(posC.y);

    // Each node in its own layer — centered at X=0
    expect(posA.x).toBe(0);
    expect(posB.x).toBe(0);
    expect(posC.x).toBe(0);
  });

  it("diamond shape (A→B, A→C, B→D, C→D) produces correct layering", () => {
    const nodes = [
      { depends_on: [], id: "A" },
      { depends_on: ["A"], id: "B" },
      { depends_on: ["A"], id: "C" },
      { depends_on: ["B", "C"], id: "D" },
    ];
    const result = computeDagLayout(nodes);
    expect(result.size).toBe(4);

    const posA = result.get("A")!;
    const posB = result.get("B")!;
    const posC = result.get("C")!;
    const posD = result.get("D")!;

    // A is at layer 0 (root)
    expect(posA.y).toBe(0);
    // B and C are at the same layer (layer 1)
    expect(posB.y).toBe(posC.y);
    // D is below B and C (layer 2)
    expect(posD.y).toBeGreaterThan(posB.y);
    // B and C should have different X positions (spread in layer)
    expect(posB.x).not.toBe(posC.x);
  });

  it("disconnected nodes (no depends_on) all appear in layer 0 with the same Y", () => {
    const nodes = [
      { depends_on: [], id: "X" },
      { depends_on: [], id: "Y" },
      { depends_on: [], id: "Z" },
    ];
    const result = computeDagLayout(nodes);
    expect(result.size).toBe(3);

    const posX = result.get("X")!;
    const posY = result.get("Y")!;
    const posZ = result.get("Z")!;

    // All at Y=0 (layer 0)
    expect(posX.y).toBe(0);
    expect(posY.y).toBe(0);
    expect(posZ.y).toBe(0);

    // Should be spread across different X positions
    const xPositions = [posX.x, posY.x, posZ.x];
    const uniqueX = new Set(xPositions);
    expect(uniqueX.size).toBe(3);
  });

  it("nodes with depends_on referencing unknown IDs are treated as roots", () => {
    // Node B depends on "missing" which is not in the node list
    const nodes = [
      { depends_on: [], id: "A" },
      { depends_on: ["missing"], id: "B" },
    ];
    const result = computeDagLayout(nodes);
    // Both A and B are returned
    expect(result.size).toBe(2);
    // B has no valid predecessor so treated as root (in-degree effectively 0)
    const posA = result.get("A")!;
    const posB = result.get("B")!;
    expect(posA.y).toBe(0);
    expect(posB.y).toBe(0);
  });

  it("uses layerSpacing and nodeSpacing parameters", () => {
    const nodes = [
      { depends_on: [], id: "A" },
      { depends_on: ["A"], id: "B" },
    ];
    const result = computeDagLayout(nodes, 300, 400);

    const posA = result.get("A")!;
    const posB = result.get("B")!;

    // B is one layer below A — Y difference should equal layerSpacing
    expect(posB.y - posA.y).toBe(300);
  });
});
