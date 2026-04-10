/**
 * Tests for classifyBlastSeverity() pure function.
 *
 * Tests severity classification rules, description string generation,
 * and the treatment of test files vs. production files.
 */

import { type BlastRadiusFile, classifyBlastSeverity } from "@graph/kg-blast-radius.ts";
import { describe, expect, it } from "vitest";

function makeFile(
  overrides: Partial<BlastRadiusFile> & Pick<BlastRadiusFile, "path">,
): BlastRadiusFile {
  return {
    depth: 1,
    in_degree: 1,
    is_test: false,
    layer: "domain",
    relationship: "imports",
    ...overrides,
  };
}

// classifyBlastSeverity — severity levels

describe("classifyBlastSeverity", () => {
  describe("contained", () => {
    it("returns contained when no files are affected", () => {
      const result = classifyBlastSeverity([], "domain");
      expect(result.severity).toBe("contained");
      expect(result.total_files).toBe(0);
      expect(result.total_production_files).toBe(0);
    });

    it("returns contained when all affected files are test files", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ is_test: true, layer: "domain", path: "src/__tests__/foo.test.ts" }),
        makeFile({ is_test: true, layer: "api", path: "src/test/bar.spec.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("contained");
      expect(result.total_files).toBe(2); // test files still counted in total_files
      expect(result.total_production_files).toBe(0);
    });

    it("returns the contained description string", () => {
      const result = classifyBlastSeverity([], "api");
      expect(result.description).toBe(
        "Changes are fully contained. No production files depend on this.",
      );
    });
  });

  describe("low", () => {
    it("returns low for 2 same-layer, low in_degree production files", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 2, layer: "domain", path: "src/a.ts" }),
        makeFile({ in_degree: 3, layer: "domain", path: "src/b.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("low");
      expect(result.total_production_files).toBe(2);
    });

    it("returns low for 1 same-layer file with in_degree exactly 5 (boundary)", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 5, layer: "domain", path: "src/a.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("low");
    });

    it("returns low description with correct count and layer name", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, layer: "api", path: "src/a.ts" }),
        makeFile({ in_degree: 2, layer: "api", path: "src/b.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "api");
      expect(result.description).toBe(
        "Low blast radius — 2 direct dependents, all within the api layer.",
      );
    });
  });

  describe("moderate", () => {
    it("returns moderate when there is 1 cross-layer production file", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, layer: "api", path: "src/api/handler.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("moderate");
      expect(result.cross_layer_count).toBe(1);
    });

    it("returns moderate for 4 same-layer production files", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, layer: "domain", path: "src/a.ts" }),
        makeFile({ in_degree: 1, layer: "domain", path: "src/b.ts" }),
        makeFile({ in_degree: 1, layer: "domain", path: "src/c.ts" }),
        makeFile({ in_degree: 1, layer: "domain", path: "src/d.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("moderate");
    });

    it("returns moderate for 8 same-layer production files (upper boundary)", () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 8 }, (_, i) =>
        makeFile({ in_degree: 1, layer: "domain", path: `src/f${i}.ts` }),
      );
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("moderate");
    });

    it("returns moderate when a low-count file has in_degree > 5 (same layer)", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 6, layer: "domain", path: "src/hub.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("moderate");
    });

    it("returns moderate description with file count and cross-layer count", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, layer: "domain", path: "src/a.ts" }),
        makeFile({ in_degree: 1, layer: "domain", path: "src/b.ts" }),
        makeFile({ in_degree: 1, layer: "domain", path: "src/c.ts" }),
        makeFile({ in_degree: 1, layer: "api", path: "src/api/handler.ts" }),
        makeFile({ in_degree: 1, layer: "api", path: "src/api/router.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.description).toBe(
        "Moderate blast radius — 5 files affected, 2 across layer boundaries.",
      );
    });
  });

  describe("high", () => {
    it("returns high for 9 same-layer production files", () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 9 }, (_, i) =>
        makeFile({ in_degree: 1, layer: "domain", path: `src/f${i}.ts` }),
      );
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("high");
    });

    it("returns high for 10+ same-layer production files", () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 10 }, (_, i) =>
        makeFile({ in_degree: 1, layer: "domain", path: `src/f${i}.ts` }),
      );
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("high");
      expect(result.total_production_files).toBe(10);
    });

    it("returns high description referencing the hub file and in_degree", () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 9 }, (_, i) =>
        makeFile({ in_degree: 1, layer: "domain", path: `src/f${i}.ts` }),
      );
      // inject a hub file
      affected.push(makeFile({ in_degree: 11, layer: "domain", path: "src/core/hub.ts" }));
      const result = classifyBlastSeverity(affected, "domain");
      // 10 prod files >= 9 AND has hub — critical check fails (no cross-layer), so high
      expect(result.severity).toBe("high");
      expect(result.description).toContain("hub");
    });
  });

  describe("critical", () => {
    it("returns critical when hub file (in_degree > 10) is cross-layer", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 15, layer: "api", path: "src/api/mega-hub.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("critical");
      expect(result.amplification_risk).toBe(true);
    });

    it("includes layer count in critical description", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 15, layer: "api", path: "src/api/mega-hub.ts" }),
        makeFile({ in_degree: 2, layer: "infra", path: "src/infra/db.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("critical");
      expect(result.description).toMatch(/critical blast radius/i);
      expect(result.description).toContain("mega-hub.ts");
    });

    it("does NOT classify as critical when hub is in same layer as seed", () => {
      // hub exists but no cross-layer → high, not critical
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 12, layer: "domain", path: "src/domain/hub.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("high");
    });
  });

  // Test file handling

  describe("test file exclusion", () => {
    it("excludes test files from severity but counts them in total_files", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, is_test: false, layer: "domain", path: "src/a.ts" }),
        makeFile({
          in_degree: 0,
          is_test: true,
          layer: "domain",
          path: "src/__tests__/a.test.ts",
        }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.total_files).toBe(2);
      expect(result.total_production_files).toBe(1);
      // 1 prod file, same layer → low
      expect(result.severity).toBe("low");
    });

    it("counts test files in cross_layer only via production filtering", () => {
      // test file is in a different layer — should NOT affect cross_layer_count
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, is_test: false, layer: "domain", path: "src/a.ts" }),
        makeFile({
          in_degree: 0,
          is_test: true,
          layer: "api",
          path: "src/__tests__/api.test.ts",
        }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      // cross_layer_count filters prod files only
      expect(result.cross_layer_count).toBe(0);
      expect(result.severity).toBe("low");
    });
  });

  // Computed metadata fields

  describe("computed metadata", () => {
    it("reports max_depth_reached correctly", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ depth: 1, in_degree: 1, layer: "domain", path: "src/a.ts" }),
        makeFile({ depth: 3, in_degree: 1, layer: "domain", path: "src/b.ts" }),
        makeFile({ depth: 2, in_degree: 1, layer: "domain", path: "src/c.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.max_depth_reached).toBe(3);
    });

    it("reports max_depth_reached as 0 for empty input", () => {
      const result = classifyBlastSeverity([], "domain");
      expect(result.max_depth_reached).toBe(0);
    });

    it("sets amplification_risk true when any file has in_degree > 10", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 11, layer: "domain", path: "src/hub.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.amplification_risk).toBe(true);
    });

    it("sets amplification_risk false when no file exceeds in_degree 10", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 10, layer: "domain", path: "src/a.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.amplification_risk).toBe(false);
    });
  });
});
