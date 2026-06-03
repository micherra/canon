import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CraftProfileSchema } from "../../schema.ts";
import {
  CRAFT_DIMENSION_PRINCIPLES,
  CRAFT_DIMENSIONS,
  craftBandOrdinal,
  craftRollup,
} from "../craft-rubric.ts";

// Resolve principles directory relative to the repo root.
// Path from __tests__: lib/ → shared/ → src/ → mcp-server/ → repo-root → principles/
// That is 5 levels up from the test file's directory.
const PRINCIPLES_ROOT = path.resolve(import.meta.dirname, "../../../../../principles");

const PRINCIPLE_SUBDIRS = ["rules", "strong-opinions", "conventions"];

function principleFileExists(principleId: string): boolean {
  return PRINCIPLE_SUBDIRS.some((subdir) => {
    const filePath = path.join(PRINCIPLES_ROOT, subdir, `${principleId}.md`);
    return fs.existsSync(filePath);
  });
}

describe("craftRollup", () => {
  it("returns mean of band ordinals on the 1–3 scale", () => {
    // strong=3, adequate=2, weak=1 → mean = 2
    const result = craftRollup([{ band: "strong" }, { band: "adequate" }, { band: "weak" }]);
    expect(result).toBe(2);
  });

  it("excludes n-a from the mean", () => {
    // strong=3, n-a excluded, adequate=2 → mean = (3+2)/2 = 2.5
    const result = craftRollup([{ band: "strong" }, { band: "n-a" }, { band: "adequate" }]);
    expect(result).toBe(2.5);
  });

  it("returns undefined when all bands are n-a", () => {
    const result = craftRollup([{ band: "n-a" }, { band: "n-a" }]);
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty ratings array", () => {
    const result = craftRollup([]);
    expect(result).toBeUndefined();
  });

  it("returns 3 for a single strong rating", () => {
    expect(craftRollup([{ band: "strong" }])).toBe(3);
  });

  it("returns 1 for a single weak rating", () => {
    expect(craftRollup([{ band: "weak" }])).toBe(1);
  });

  it("computes fractional mean correctly for 6 ratings", () => {
    // strong(3) + adequate(2) + strong(3) + adequate(2) + weak(1) + adequate(2) = 13/6 ≈ 2.1667
    const result = craftRollup([
      { band: "strong" },
      { band: "adequate" },
      { band: "strong" },
      { band: "adequate" },
      { band: "weak" },
      { band: "adequate" },
    ]);
    expect(result).toBeCloseTo(13 / 6, 10);
  });
});

describe("craftBandOrdinal", () => {
  it("returns 3 for strong", () => {
    expect(craftBandOrdinal("strong")).toBe(3);
  });

  it("returns 2 for adequate", () => {
    expect(craftBandOrdinal("adequate")).toBe(2);
  });

  it("returns 1 for weak", () => {
    expect(craftBandOrdinal("weak")).toBe(1);
  });

  it("returns null for n-a", () => {
    expect(craftBandOrdinal("n-a")).toBeNull();
  });
});

describe("CRAFT_DIMENSION_PRINCIPLES", () => {
  it("every dimension maps to at least one principle", () => {
    for (const dim of CRAFT_DIMENSIONS) {
      const refs = CRAFT_DIMENSION_PRINCIPLES[dim];
      expect(refs, `dimension '${dim}' must have at least one principle`).toBeDefined();
      expect(refs.length, `dimension '${dim}' must have at least one principle`).toBeGreaterThan(0);
    }
  });

  it("every referenced principle ID resolves to an existing file", () => {
    for (const dim of CRAFT_DIMENSIONS) {
      const refs = CRAFT_DIMENSION_PRINCIPLES[dim];
      for (const principleId of refs) {
        expect(
          principleFileExists(principleId),
          `principle '${principleId}' (dimension '${dim}') not found under principles/{rules,strong-opinions,conventions}/`,
        ).toBe(true);
      }
    }
  });
});

describe("CraftProfileSchema", () => {
  it("accepts a valid craft profile with all 6 dimensions rated", () => {
    const result = CraftProfileSchema.safeParse({
      ratings: [
        { dimension: "simplicity", band: "strong" },
        { dimension: "cohesion", band: "adequate", evidence: "clear SRP" },
        { dimension: "interface-depth", band: "weak" },
        { dimension: "naming", band: "n-a" },
        { dimension: "locality", band: "strong", principle_refs: ["leave-touched-files-better"] },
        { dimension: "predictability", band: "adequate" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts n-a as a valid band", () => {
    const result = CraftProfileSchema.safeParse({
      ratings: [{ dimension: "simplicity", band: "n-a" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional rollup field", () => {
    const result = CraftProfileSchema.safeParse({
      ratings: [{ dimension: "simplicity", band: "strong" }],
      rollup: 2.5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown dimension", () => {
    const result = CraftProfileSchema.safeParse({
      ratings: [{ dimension: "unknown-dimension", band: "strong" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown band", () => {
    const result = CraftProfileSchema.safeParse({
      ratings: [{ dimension: "simplicity", band: "excellent" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a profile where band is missing", () => {
    const result = CraftProfileSchema.safeParse({
      ratings: [{ dimension: "simplicity" }],
    });
    expect(result.success).toBe(false);
  });
});
