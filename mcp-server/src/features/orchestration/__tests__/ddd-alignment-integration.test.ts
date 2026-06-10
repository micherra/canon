/**
 * Integration tests for the DDD alignment epic (ddd-01 through ddd-13).
 *
 * These tests verify cross-task contracts and coverage gaps:
 *   1. Schema split: flow-schema.ts is deleted; no importer references it
 *   2. Bounded context directories: all 8 READMEs exist (dc-06)
 *   3. Boundary enforcement: npm run lint:deps exits 0 (dc-04)
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
      "transcript-schemas.ts",
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
// 2. Bounded context directory structure — all 8 READMEs exist (dc-06)
// ---------------------------------------------------------------------------

describe("bounded context directories — README.md files (dc-06)", () => {
  const REQUIRED_READMES = [
    "domains/flows/README.md",
    "domains/workspaces/README.md",
    "domains/board/README.md",
    "domains/messages/README.md",
    "domains/knowledge-graph/README.md",
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
// 3. Boundary enforcement — dependency-cruiser (dc-04)
// ---------------------------------------------------------------------------

describe("boundary enforcement — dependency-cruiser (dc-04)", () => {
  it("npm run lint:deps exits 0 (no boundary violations)", { timeout: 30000 }, () => {
    // Invoke depcruise via the local binary rather than `npm run lint:deps` to ensure
    // deterministic CWD and config resolution regardless of how the test runner is invoked.
    // `npm run` can pick up a different CWD or spawn a sub-shell that resolves depcruise
    // from a different PATH entry (e.g., a system install with a different version or
    // different config lookup). Using the local binary ensures we always scan the same
    // src/ tree with the same .dependency-cruiser.cjs that lives next to it.
    const depcruiseBin = resolve(MCP_SERVER_ROOT, "node_modules", ".bin", "depcruise");
    const configPath = resolve(MCP_SERVER_ROOT, ".dependency-cruiser.cjs");
    const srcPath = resolve(MCP_SERVER_ROOT, "src");

    let exitCode = 0;
    let stderr = "";
    try {
      execFileSync(depcruiseBin, ["--validate", configPath, srcPath], {
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
