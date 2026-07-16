/**
 * Tests for mcp-server/scripts/lib/ts-compiler.mjs — the fail-loud parser seam
 * introduced by the TypeScript 7 migration (docs/adr/0056-*.md).
 *
 * The seam's `PARSER_SPECIFIER` ("typescript-parser") is a bare ESM specifier,
 * which Node resolves relative to the importing file's own directory — not
 * cwd (see the module-resolution note in each consuming script). To exercise
 * "missing module" and "stub module" cases WITHOUT weakening the seam itself
 * (no injected specifier, no test-only hook), each case copies the real seam
 * module into an isolated `mkdtemp` directory with a controlled `node_modules`
 * layout, then drives it via a tiny subprocess driver that imports the copy
 * and calls `loadTsCompiler`. Node's own module resolution — walking up from
 * the copy's directory — does the rest.
 *
 * These are integration tests that actually spawn a subprocess, mirroring the
 * pattern in dead-wire-internal-use.test.ts.
 */

import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const REAL_SEAM = resolve(
  fileURLToPath(import.meta.url),
  // __tests__ -> src -> mcp-server -> scripts/lib/ts-compiler.mjs
  "../../../scripts/lib/ts-compiler.mjs",
);

let WORK_DIR: string;

beforeAll(() => {
  WORK_DIR = mkdtempSync(join(tmpdir(), "ts-compiler-seam-test-"));
});

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
});

/** Run a Node subprocess; resolve with { code, stdout, stderr }. */
function run(
  scriptPath: string,
  args: string[] = [],
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveP) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      { timeout: 10_000 },
      (err, stdout, stderr) => {
        const code = typeof err?.code === "number" ? err.code : err?.code ? 1 : 0;
        resolveP({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      },
    );
  });
}

/**
 * Sets up an isolated directory containing a copy of the real seam module
 * plus a driver script that imports it and calls `loadTsCompiler(scriptName,
 * requiredApis)`. Returns the driver's path.
 */
function setupDriver(dirName: string): { dir: string; driver: string } {
  const dir = join(WORK_DIR, dirName);
  mkdirSync(dir, { recursive: true });
  copyFileSync(REAL_SEAM, join(dir, "ts-compiler.mjs"));
  const driverPath = join(dir, "driver.mjs");
  writeFileSync(
    driverPath,
    `import { loadTsCompiler } from "./ts-compiler.mjs";
const requiredApis = JSON.parse(process.argv[2]);
const ts = await loadTsCompiler("test-driver", requiredApis);
process.stdout.write("OK:" + Object.keys(ts).length + "\\n");
process.exit(0);
`,
    "utf8",
  );
  return { dir, driver: driverPath };
}

describe("ts-compiler.mjs — fail-loud parser seam", () => {
  // -------------------------------------------------------------------
  // Case 1: missing module — no node_modules/typescript-parser anywhere
  // up the directory tree from the driver's location.
  // -------------------------------------------------------------------
  test("missing module: non-zero exit, stderr names the specifier", async () => {
    const { driver } = setupDriver("missing-module");
    const { code, stderr } = await run(driver, ["[]"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("CANON ERROR [test-driver]");
    expect(stderr).toContain("typescript-parser");
  });

  // -------------------------------------------------------------------
  // Case 2: module present but API surface incomplete — a stub package
  // exporting only `{ version }`, missing every real compiler API member.
  // -------------------------------------------------------------------
  test("module present, required key missing: non-zero exit, stderr names the missing key", async () => {
    const { dir, driver } = setupDriver("stub-module");
    const nodeModulesDir = join(dir, "node_modules", "typescript-parser");
    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(
      join(nodeModulesDir, "package.json"),
      JSON.stringify({
        name: "typescript-parser",
        version: "0.0.0-stub",
        type: "module",
        main: "index.js",
      }),
      "utf8",
    );
    writeFileSync(
      join(nodeModulesDir, "index.js"),
      `export default { version: "0.0.0-stub" };\n`,
      "utf8",
    );

    const { code, stderr } = await run(driver, [
      JSON.stringify(["createSourceFile", "ScriptTarget"]),
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("CANON ERROR [test-driver]");
    expect(stderr).toContain("createSourceFile");
    expect(stderr).toContain("ScriptTarget");
  });

  // -------------------------------------------------------------------
  // Case 3: full API present (the real typescript@6.0.3 alias, resolved
  // from mcp-server/node_modules) — returns the API, exit 0. Driven from a
  // throwaway driver colocated next to the REAL scripts/lib/ts-compiler.mjs
  // (not a copy), so resolution finds the real installed node_modules.
  // -------------------------------------------------------------------
  test("full API present (real install): loadTsCompiler returns the API, exit 0", async () => {
    const realLibDir = resolve(REAL_SEAM, "..");
    const driverPath = join(realLibDir, "__seam-test-driver.mjs");
    writeFileSync(
      driverPath,
      `import { loadTsCompiler } from "./ts-compiler.mjs";
const ts = await loadTsCompiler("test-driver", ["createSourceFile", "ScriptTarget", "ScriptKind", "SyntaxKind", "forEachChild"]);
process.stdout.write("OK:" + typeof ts.createSourceFile + "\\n");
process.exit(0);
`,
      "utf8",
    );
    try {
      const { code, stdout, stderr } = await run(driverPath, []);
      expect(code).toBe(0);
      expect(stdout).toBe("OK:function");
      expect(stderr).toBe("");
    } finally {
      rmSync(driverPath, { force: true });
    }
  });

  // -------------------------------------------------------------------
  // Case 4 (security finding): surface-complete but BEHAVIORALLY degraded
  // parser — every top-level API member the caller declared is present
  // (so the existing surface assertion passes cleanly), but the returned
  // SourceFile's `parseDiagnostics` is undefined. This is the exact shape
  // a reviewer-constructed adversarial stub demonstrated silently passing
  // workflows-lint.mjs's `sf.parseDiagnostics ?? []` fallback (real parser:
  // exits 1 naming a parse error; degraded parser: exits 0, no output).
  // `parseDiagnostics` is a property of the object createSourceFile
  // RETURNS, not a top-level `ts.*` member, so the plain surface assertion
  // structurally cannot see this gap — and it is absent from
  // typescript-parser's public .d.ts (an internal, undocumented API),
  // exactly the class of surface that can vanish across an alias bump.
  //
  // Case A: caller declares createSourceFile + ScriptTarget + ScriptKind
  // (the shape every current real caller uses).
  // -------------------------------------------------------------------
  test("Case A — declares createSourceFile+ScriptTarget+ScriptKind: non-zero exit (behavioral probe)", async () => {
    const { dir, driver } = setupDriver("degraded-parsediagnostics-case-a");
    const nodeModulesDir = join(dir, "node_modules", "typescript-parser");
    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(
      join(nodeModulesDir, "package.json"),
      JSON.stringify({
        name: "typescript-parser",
        version: "0.0.0-stub",
        type: "module",
        main: "index.js",
      }),
      "utf8",
    );
    writeFileSync(
      join(nodeModulesDir, "index.js"),
      `export default {
  version: "0.0.0-stub",
  ScriptTarget: { Latest: 99 },
  ScriptKind: { JS: 1 },
  // Fully present and callable — passes the top-level surface assertion —
  // but the SourceFile it returns never reports parseDiagnostics, no
  // matter how malformed the input. This is the degradation the surface
  // assertion alone cannot catch.
  createSourceFile(fileName, text) {
    return { fileName, text, kind: "SourceFile" };
  },
};
`,
      "utf8",
    );

    const { code, stderr } = await run(driver, [
      JSON.stringify(["createSourceFile", "ScriptTarget", "ScriptKind"]),
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("CANON ERROR [test-driver]");
    expect(stderr).toContain("parseDiagnostics");
  });

  // -------------------------------------------------------------------
  // Case B (review finding — the gate itself was wrong): caller declares
  // ONLY createSourceFile + ScriptTarget — `ScriptKind` is an OPTIONAL
  // parameter of `createSourceFile`, so a caller can legitimately parse
  // without ever declaring it. Gating the probe on all three (the
  // sec-fix-1 shape) was STRICTER than the actual condition ("does this
  // caller parse?") and left this narrower shape unprobed — a plain-object
  // stub identical to Case A's, minus `ScriptKind`, demonstrated the probe
  // does NOT fire and the silent pass returns. The seam must gate on
  // `createSourceFile` alone.
  // -------------------------------------------------------------------
  test("Case B — declares createSourceFile+ScriptTarget only (ScriptKind omitted): non-zero exit", async () => {
    const { dir, driver } = setupDriver("degraded-parsediagnostics-case-b");
    const nodeModulesDir = join(dir, "node_modules", "typescript-parser");
    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(
      join(nodeModulesDir, "package.json"),
      JSON.stringify({
        name: "typescript-parser",
        version: "0.0.0-stub",
        type: "module",
        main: "index.js",
      }),
      "utf8",
    );
    writeFileSync(
      join(nodeModulesDir, "index.js"),
      `export default {
  version: "0.0.0-stub",
  ScriptTarget: { Latest: 99 },
  // No ScriptKind export at all — this caller never declared it.
  // createSourceFile is valid without a scriptKind argument (it is
  // optional) — fully present and callable, passes the top-level surface
  // assertion for this caller's declared requiredApis — but the returned
  // SourceFile never reports parseDiagnostics.
  createSourceFile(fileName, text) {
    return { fileName, text, kind: "SourceFile" };
  },
};
`,
      "utf8",
    );

    const { code, stderr } = await run(driver, [
      JSON.stringify(["createSourceFile", "ScriptTarget"]),
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("CANON ERROR [test-driver]");
    expect(stderr).toContain("parseDiagnostics");
  });
});
