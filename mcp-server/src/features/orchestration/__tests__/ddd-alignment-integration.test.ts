/**
 * Integration tests for the DDD alignment epic (ddd-01 through ddd-13).
 *
 * These tests verify cross-task contracts and coverage gaps:
 *   1. Schema split: flow-schema.ts is deleted; no importer references it
 *   2. Interface import paths: all 3 repository interfaces live in domains/ layer
 *   3. IDriftStore injection: effects.ts honours the optional driftStore override path
 *   4. Bounded context directories: all 9 READMEs exist (dc-06)
 *   5. Boundary enforcement: npm run lint:deps exits 0 (dc-04)
 *
 * These are integration-level tests that exercise cross-module contracts,
 * not the unit behaviour of individual schemas or stores (covered by implementors).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { executeEffects } from "../engine/effects.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the test file location:
//   __dirname = .../mcp-server/src/features/orchestration/__tests__
//   ../../..  = .../mcp-server/src  (SRC)
//   ../../../.. = .../mcp-server    (MCP_SERVER_ROOT)
const SRC = resolve(__dirname, "../../..");
const MCP_SERVER_ROOT = resolve(__dirname, "../../../..");

// ---------------------------------------------------------------------------
// 1. Schema split: flow-schema.ts must not exist (dc-02)
// ---------------------------------------------------------------------------

describe("schema split — flow-schema.ts deletion (dc-02)", () => {
  it("flow-schema.ts does not exist in domains/flows/", () => {
    const deletedPath = resolve(SRC, "domains/flows/flow-schema.ts");
    expect(existsSync(deletedPath), `flow-schema.ts still exists at ${deletedPath}`).toBe(false);
  });

  it("all 3 bounded-context schema files exist in domains/flows/", () => {
    const required = [
      "flow-definition-schemas.ts",
      "board-state-schemas.ts",
      "event-schemas.ts",
    ] as const;
    for (const file of required) {
      const filePath = resolve(SRC, "domains/flows", file);
      expect(existsSync(filePath), `Missing schema file: ${file}`).toBe(true);
    }
  });

  it("no source file has a live import from flow-schema.ts", () => {
    // Search for TypeScript import declarations that reference flow-schema.
    // Pattern: lines starting with 'import' that contain flow-schema in a string literal.
    // Exclude this test file itself (it mentions "flow-schema.ts" in descriptions).
    const result = execSync(`grep -rn "^import.*flow-schema" "${SRC}" --include="*.ts" || true`, {
      cwd: MCP_SERVER_ROOT,
      encoding: "utf-8",
    });

    // Exclude this integration test file from results (it names flow-schema in test descriptions)
    const thisFile = "ddd-alignment-integration.test.ts";
    const importLines = result
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.includes(thisFile));

    expect(
      importLines,
      `Found live imports from flow-schema.ts:\n${importLines.join("\n")}`,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Repository interface files: correct layer placement and cross-context
//    callers import from domains/ (dc-03)
// ---------------------------------------------------------------------------

describe("repository interfaces — correct layer placement (dc-03)", () => {
  it("IExecutionStore interface file exists at domains/workspaces/execution-store.interface.ts", () => {
    const path = resolve(SRC, "domains/workspaces/execution-store.interface.ts");
    expect(existsSync(path)).toBe(true);
  });

  it("IKgStore/IKgQuery interface file exists at domains/knowledge-graph/kg-store.interface.ts", () => {
    const path = resolve(SRC, "domains/knowledge-graph/kg-store.interface.ts");
    expect(existsSync(path)).toBe(true);
  });

  it("IDriftStore interface file exists at domains/drift/drift-store.interface.ts", () => {
    const path = resolve(SRC, "domains/drift/drift-store.interface.ts");
    expect(existsSync(path)).toBe(true);
  });

  it("IExecutionStore is exported from its interface file", () => {
    const content = readFileSync(
      resolve(SRC, "domains/workspaces/execution-store.interface.ts"),
      "utf-8",
    );
    expect(content).toMatch(/export (?:interface|type) IExecutionStore/);
  });

  it("IDriftStore is exported from its interface file", () => {
    const content = readFileSync(resolve(SRC, "domains/drift/drift-store.interface.ts"), "utf-8");
    expect(content).toMatch(/export (?:interface|type) IDriftStore/);
  });

  it("IKgStore and IKgQuery are exported from their interface file", () => {
    const content = readFileSync(
      resolve(SRC, "domains/knowledge-graph/kg-store.interface.ts"),
      "utf-8",
    );
    expect(content).toMatch(/export (?:interface|type) IKgStore/);
    expect(content).toMatch(/export (?:interface|type) IKgQuery/);
  });

  it("effects.ts imports IDriftStore from @domains/drift/ (not directly from @platform/)", () => {
    const content = readFileSync(resolve(SRC, "features/orchestration/engine/effects.ts"), "utf-8");
    expect(content).toMatch(/from ["']@domains\/drift\/drift-store\.interface/);
  });

  it("kg-context-formatter.ts imports IKgStore/IKgQuery from @domains/knowledge-graph/", () => {
    // Since inject-context.ts now delegates to the shared kg-context-formatter module,
    // the DDD boundary is enforced in that module instead.
    const content = readFileSync(
      resolve(SRC, "features/orchestration/services/kg-context-formatter.ts"),
      "utf-8",
    );
    expect(content).toMatch(/from ["']@domains\/knowledge-graph\/kg-store\.interface/);
  });

  it("IExecutionStore imports types from split schema files (not deleted flow-schema.ts)", () => {
    const content = readFileSync(
      resolve(SRC, "domains/workspaces/execution-store.interface.ts"),
      "utf-8",
    );
    // Must reference the split files
    expect(content).toMatch(/@domains\/flows\/board-state-schemas/);
    expect(content).toMatch(/@domains\/flows\/flow-definition-schemas/);
    expect(content).toMatch(/@domains\/flows\/event-schemas/);
    // Must NOT reference the deleted monolithic file
    expect(content).not.toMatch(/flow-schema['"]/);
  });
});

// ---------------------------------------------------------------------------
// 3. IDriftStore injection — effects.ts optional driftStore override path
//    Declared Known Gap in ddd-03: "the new driftStore?: IDriftStore path is
//    not exercised by existing tests"
// ---------------------------------------------------------------------------

describe("IDriftStore injection — effects.ts optional driftStore override (ddd-03 known gap)", () => {
  it("executeEffects short-circuits with no effects and does not call the injected store", async () => {
    const calls: string[] = [];
    const mockStore = {
      appendFlowRun: async () => {},
      appendReview: async () => {
        calls.push("appendReview");
      },
      countFlowRunsSince: () => 0,
      getComplianceTrend: async () => [],
      getLastReviewForBranch: async () => null,
      getLastReviewForPr: async () => null,
      getReviews: async () => [],
      getReviewsForFiles: async () => [],
    };

    const stateDef = {
      agent: "canon:canon-implementor",
      effects: undefined,
      type: "single" as const,
    };

    const result = await executeEffects(stateDef as never, {
      artifacts: [],
      driftStore: mockStore,
      projectDir: "/nonexistent",
      workspace: "/nonexistent",
    });

    // No effects declared → empty array returned; injected store never called
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("executeEffects uses the injected driftStore.appendReview when persist_review effect is declared", async () => {
    const appendedReviews: unknown[] = [];
    const mockStore = {
      appendFlowRun: async () => {},
      appendReview: async (entry: unknown) => {
        appendedReviews.push(entry);
      },
      countFlowRunsSince: () => 0,
      getComplianceTrend: async () => [],
      getLastReviewForBranch: async () => null,
      getLastReviewForPr: async () => null,
      getReviews: async () => [],
      getReviewsForFiles: async () => [],
    };

    const tmpDir = mkdtempSync(`${tmpdir()}/effects-test-`);
    const reviewMeta = {
      _type: "review",
      _version: 1,
      verdict: "CLEAN",
      violations: [],
    };
    writeFileSync(`${tmpDir}/REVIEW.meta.json`, JSON.stringify(reviewMeta));

    try {
      const stateDef = {
        agent: "canon:canon-reviewer",
        effects: [{ type: "persist_review" }],
        type: "single" as const,
      };

      await executeEffects(stateDef as never, {
        artifacts: [`${tmpDir}/REVIEW.meta.json`],
        driftStore: mockStore,
        projectDir: tmpDir,
        workspace: tmpDir,
      });

      // The injected mockStore.appendReview must have been called — not the real DriftStore
      expect(appendedReviews.length).toBeGreaterThan(0);
      const review = appendedReviews[0] as Record<string, unknown>;
      expect(review.verdict).toBe("CLEAN");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("executeEffects empty-effects array also short-circuits without calling the store", async () => {
    const calls: string[] = [];
    const mockStore = {
      appendFlowRun: async () => {},
      appendReview: async () => {
        calls.push("appendReview");
      },
      countFlowRunsSince: () => 0,
      getComplianceTrend: async () => [],
      getLastReviewForBranch: async () => null,
      getLastReviewForPr: async () => null,
      getReviews: async () => [],
      getReviewsForFiles: async () => [],
    };

    const stateDef = {
      agent: "canon:canon-implementor",
      effects: [],
      type: "single" as const,
    };

    const result = await executeEffects(stateDef as never, {
      artifacts: [],
      driftStore: mockStore,
      projectDir: "/nonexistent",
      workspace: "/nonexistent",
    });

    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Bounded context directory structure — all 9 READMEs exist (dc-06)
// ---------------------------------------------------------------------------

describe("bounded context directories — README.md files (dc-06)", () => {
  const REQUIRED_READMES = [
    "domains/flows/README.md",
    "domains/workspaces/README.md",
    "domains/board/README.md",
    "domains/messages/README.md",
    "domains/knowledge-graph/README.md",
    "domains/drift/README.md",
    "graph/README.md",
    "platform/README.md",
    "shared/README.md",
  ] as const;

  for (const readmePath of REQUIRED_READMES) {
    it(`README.md exists at src/${readmePath}`, () => {
      const fullPath = resolve(SRC, readmePath);
      expect(existsSync(fullPath), `Missing README: src/${readmePath}`).toBe(true);
    });
  }

  it("each README.md has non-empty content", () => {
    for (const readmePath of REQUIRED_READMES) {
      const fullPath = resolve(SRC, readmePath);
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, "utf-8").trim();
        expect(content.length, `README at src/${readmePath} is empty`).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Boundary enforcement — dependency-cruiser (dc-04)
// ---------------------------------------------------------------------------

describe("boundary enforcement — dependency-cruiser (dc-04)", () => {
  it("npm run lint:deps exits 0 (no boundary violations)", { timeout: 30000 }, () => {
    let exitCode = 0;
    let stderr = "";
    try {
      execSync("npm run lint:deps", {
        cwd: MCP_SERVER_ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 25000,
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string };
      exitCode = e.status ?? 1;
      stderr = e.stderr ?? "";
    }
    expect(exitCode, `dependency-cruiser reported boundary violations:\n${stderr}`).toBe(0);
  });

  it(".dependency-cruiser.cjs exists and contains all 5 boundary rules", () => {
    const configPath = resolve(MCP_SERVER_ROOT, ".dependency-cruiser.cjs");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");
    const requiredRules = [
      "no-orchestration-to-graph-direct",
      "no-orchestration-to-drift-direct",
      "no-flows-to-orchestration",
      "no-graph-to-orchestration",
      "no-drift-to-orchestration",
    ] as const;
    for (const rule of requiredRules) {
      expect(content, `Missing boundary rule: ${rule}`).toContain(rule);
    }
  });

  it("ci.yml includes npm run lint:deps step", () => {
    const ciPath = resolve(MCP_SERVER_ROOT, "../.github/workflows/ci.yml");
    if (existsSync(ciPath)) {
      const content = readFileSync(ciPath, "utf-8");
      expect(content).toMatch(/npm run lint:deps/);
    }
    // Structural check: lint:deps is in package.json scripts
    const pkgPath = resolve(MCP_SERVER_ROOT, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["lint:deps"], "lint:deps script not in package.json").toBeDefined();
    expect(pkg.scripts?.["lint:deps"]).toMatch(/depcruise/);
  });
});
