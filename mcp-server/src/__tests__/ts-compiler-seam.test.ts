/**
 * Tests for mcp-server/scripts/lib/ts-compiler.mjs — the fail-loud parser seam
 * introduced by the TypeScript 7 migration (docs/adr/0061-*.md).
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

  // -------------------------------------------------------------------
  // Case C (adversarial review — harden-1): single-fixture-special-casing
  // stub. A stub that reports real parseDiagnostics ONLY for the exact
  // string the sec-fix-1 probe used ("const x = ;") and empty diagnostics
  // for everything else — including a genuinely different malformed
  // fixture — passed the seam cleanly. Closed by adding a second,
  // structurally different malformed fixture parsed under a different
  // ScriptKind (TS interface member with a missing type), so defeating
  // both requires special-casing two unrelated strings across two
  // ScriptKinds, not memorizing one.
  // -------------------------------------------------------------------
  test("Case C — stub special-cases only the original JS fixture: non-zero exit (second fixture probe)", async () => {
    const { dir, driver } = setupDriver("single-fixture-special-case");
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
  ScriptKind: { JS: 1, TS: 3 },
  // Fully present and callable, and genuinely reports parseDiagnostics —
  // but ONLY for the exact fixture text the original (sec-fix-1) probe
  // used. Any other input, including a structurally different malformed
  // fixture, gets an empty (silently "clean") parseDiagnostics array.
  createSourceFile(fileName, text) {
    const isMemorizedFixture = text === "const x = ;";
    return {
      fileName,
      text,
      kind: "SourceFile",
      statements: [{ kind: 244 }],
      parseDiagnostics: isMemorizedFixture ? [{ messageText: "memorized fixture only" }] : [],
    };
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
  });

  // -------------------------------------------------------------------
  // Case D (adversarial review — harden-1): degenerate-AST stub. A stub
  // that correctly reports parseDiagnostics for BOTH malformed fixtures
  // (passing both diagnostic probes) but always returns an empty/degenerate
  // `statements` array — even for genuinely valid input — passed the seam
  // cleanly, because nothing checked that the returned tree was real and
  // walkable. Closed by a positive AST-shape assertion: parse a KNOWN-valid
  // source and require both the expected statement count AND a non-zero
  // forEachChild walk over it.
  // -------------------------------------------------------------------
  test("Case D — stub reports diagnostics correctly but returns a degenerate AST: non-zero exit (shape probe)", async () => {
    const { dir, driver } = setupDriver("degenerate-ast-stub");
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
  ScriptKind: { JS: 1, TS: 3 },
  // Genuinely detects BOTH malformed probe fixtures and reports real
  // parseDiagnostics for them (passes the diagnostic-reporting probes) —
  // but ALWAYS returns an empty statements array, even for genuinely
  // valid input. A parser that reports diagnostics correctly but returns
  // a structurally wrong/empty AST would silently misfire every
  // downstream ban-walk and binding count.
  createSourceFile(fileName, text) {
    const isMalformed = text.includes("= ;") || text.includes(": ;");
    return {
      fileName,
      text,
      kind: "SourceFile",
      statements: [], // degenerate: always empty, regardless of input validity
      forEachChildResult: undefined,
      parseDiagnostics: isMalformed ? [{ messageText: "malformed" }] : [],
    };
  },
  forEachChild(node, cb) {
    // Faithfully walk whatever "statements" the (degenerate) SourceFile
    // reports — an empty array yields zero children, exactly the
    // real-world symptom this probe must catch.
    for (const s of node.statements ?? []) cb(s);
  },
};
`,
      "utf8",
    );

    const { code, stderr } = await run(driver, [
      JSON.stringify(["createSourceFile", "ScriptTarget", "ScriptKind", "forEachChild"]),
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("CANON ERROR [test-driver]");
  });

  // -------------------------------------------------------------------
  // Case E (adversarial review, ATTACK 4 — harden-2): the shape-probe
  // symmetry gap. Probe C validates the valid-tree walk under ScriptKind.JS
  // alone — but two of the three real callers (dead-wire-internal-use,
  // tool-surfacing-extract, both fail-closed safety hooks) parse
  // exclusively in TS/TSX mode. A stub correct on diagnostics in BOTH
  // modes, and correct-tree for valid JS, but returning a degenerate empty
  // tree specifically for valid TS passed the seam cleanly — the exact
  // mode the two safety-hook extractors actually use was unprobed. Closed
  // by mirroring Probe C for TypeScript: a known-valid TS source
  // (`"const y: number = 1;"`, explicit ScriptKind.TS) must also produce
  // the expected statement count and a walkable tree.
  // -------------------------------------------------------------------
  test("Case E — stub correct for valid JS but degenerate for valid TS: non-zero exit (TS shape probe)", async () => {
    const { dir, driver } = setupDriver("degenerate-valid-ts-stub");
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
  ScriptKind: { JS: 1, TS: 3 },
  // Correctly reports diagnostics for BOTH malformed fixtures (passes
  // Probes A+B) and returns a correct, walkable tree for valid JS (passes
  // Probe C) — but returns a degenerate empty statements array
  // specifically for valid TS input. A stub tuned to defeat only the
  // JS-mode shape probe while remaining correct everywhere else the seam
  // already checks.
  createSourceFile(fileName, text) {
    const isMalformedJs = text === "const x = ;";
    const isMalformedTs = text === "interface Foo { bar: ; }";
    const isValidJs = text === "const y = 1;";

    if (isMalformedJs || isMalformedTs) {
      return {
        fileName,
        text,
        kind: "SourceFile",
        statements: [{ kind: 244 }],
        parseDiagnostics: [{ messageText: "malformed" }],
      };
    }
    if (isValidJs) {
      return {
        fileName,
        text,
        kind: "SourceFile",
        statements: [{ kind: 244 }],
        parseDiagnostics: [],
      };
    }
    // Everything else (including the valid-TS shape-probe fixture) gets a
    // degenerate, empty tree.
    return { fileName, text, kind: "SourceFile", statements: [], parseDiagnostics: [] };
  },
  forEachChild(node, cb) {
    for (const s of node.statements ?? []) cb(s);
  },
};
`,
      "utf8",
    );

    const { code, stderr } = await run(driver, [
      JSON.stringify(["createSourceFile", "ScriptTarget", "ScriptKind", "forEachChild"]),
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("CANON ERROR [test-driver]");
  });

  // -------------------------------------------------------------------
  // Case F (adversarial review — harden-3): the third ScriptKind gap. Both
  // TS-mode real callers (dead-wire-internal-use.mjs, tool-surfacing-extract.mjs)
  // branch to ScriptKind.TSX for ".tsx" files — a distinct enum value (4,
  // vs. TS's 3) selecting the JSX grammar. Probe D only exercised
  // ScriptKind.TS; the callers' actual TSX code path was unprobed. A stub
  // correct on every existing fixture (A/B/C/D) — including correctly
  // keying its valid-TS response to ScriptKind.TS specifically, not just
  // matching source text — but returning a degenerate empty tree for the
  // same source parsed under ScriptKind.TSX passed the seam cleanly.
  // Closed by mirroring Probe D under explicit ScriptKind.TSX.
  // -------------------------------------------------------------------
  test("Case F — stub correct on A/B/C/D but degenerate under ScriptKind.TSX: non-zero exit", async () => {
    const { dir, driver } = setupDriver("degenerate-tsx-stub");
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
  ScriptKind: { JS: 1, TS: 3, TSX: 4 },
  // Correctly reports diagnostics for BOTH malformed fixtures and returns
  // a correct, walkable tree for BOTH valid-JS and valid-TS (Probes A-D
  // all pass) — keying the valid-TS branch to ScriptKind.TS specifically,
  // not merely the source text, so a naive "same text = same handling"
  // stub-detector would not catch it. Only a TSX-mode parse of the exact
  // same valid-TS source gets a degenerate, empty tree.
  createSourceFile(fileName, text, languageVersion, setParentNodes, scriptKind) {
    const isMalformedJs = text === "const x = ;";
    const isMalformedTs = text === "interface Foo { bar: ; }" && scriptKind === 3;
    const isValidJs = text === "const y = 1;" && scriptKind === undefined;
    const isValidTs = text === "const y: number = 1;" && scriptKind === 3;

    if (isMalformedJs || isMalformedTs) {
      return {
        fileName,
        text,
        kind: "SourceFile",
        statements: [{ kind: 244 }],
        parseDiagnostics: [{ messageText: "malformed" }],
      };
    }
    if (isValidJs || isValidTs) {
      return {
        fileName,
        text,
        kind: "SourceFile",
        statements: [{ kind: 244 }],
        parseDiagnostics: [],
      };
    }
    // Everything else — including the same valid-TS source parsed under
    // ScriptKind.TSX — gets a degenerate, empty tree.
    return { fileName, text, kind: "SourceFile", statements: [], parseDiagnostics: [] };
  },
  forEachChild(node, cb) {
    for (const s of node.statements ?? []) cb(s);
  },
};
`,
      "utf8",
    );

    const { code, stderr } = await run(driver, [
      JSON.stringify(["createSourceFile", "ScriptTarget", "ScriptKind", "forEachChild"]),
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("CANON ERROR [test-driver]");
  });

  // -------------------------------------------------------------------
  // Case G (adversarial review — harden-4, LIVE not latent): the call-shape
  // parity gap. Probe C (valid-JS AST shape) called createSourceFile with
  // ONLY 4 args, so `scriptKind` was `undefined` — but the real caller,
  // workflows-lint.mjs:140, ALWAYS passes ts.ScriptKind.JS (1) explicitly
  // as the 5th arg. A stub correct on every probe exactly as the seam
  // issued it (including keying valid-JS to `scriptKind === undefined`,
  // matching Probe C's pre-fix call) but degenerate for the SAME source
  // parsed under explicit ScriptKind.JS passed the seam cleanly — while
  // silently returning an empty, unwalkable tree for workflows-lint's own
  // real call shape. The reviewer proved this executable: replaying
  // workflows-lint.mjs:140's exact 5-arg call against this stub on real
  // workflow source yields `statements.length: 0`, zero forEachChild
  // children — the ban-walk would see an empty, "clean" file. Closed by
  // making Probe C (and Probe A, the same 4-vs-5-arg gap on the malformed-
  // diagnostic axis) issue createSourceFile with the exact argument vector
  // its real caller uses: ts.ScriptTarget.Latest, true, ts.ScriptKind.JS.
  // -------------------------------------------------------------------
  test("Case G — stub correct for scriptKind===undefined but degenerate under explicit ScriptKind.JS: non-zero exit", async () => {
    const { dir, driver } = setupDriver("degenerate-explicit-js-scriptkind-stub");
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
  ScriptKind: { JS: 1, TS: 3, TSX: 4 },
  // Correct for every probe call shape the seam issues TODAY (pre-fix):
  // Probe A/C key valid/malformed JS to scriptKind === undefined (the
  // 4-arg call); Probe B/D/E key TS/TSX to explicit scriptKind 3/4. A
  // stub tuned exactly to those shapes — degenerate for anything else,
  // including the real caller's explicit ScriptKind.JS (1).
  createSourceFile(fileName, text, languageVersion, setParentNodes, scriptKind) {
    const isMalformedJs = text === "const x = ;" && scriptKind === undefined;
    const isMalformedTs = text === "interface Foo { bar: ; }" && scriptKind === 3;
    const isValidJs = text === "const y = 1;" && scriptKind === undefined;
    const isValidTs = text === "const y: number = 1;" && scriptKind === 3;
    const isValidTsx = text === "const y: number = 1;" && scriptKind === 4;

    if (isMalformedJs || isMalformedTs) {
      return {
        fileName,
        text,
        kind: "SourceFile",
        statements: [{ kind: 244 }],
        parseDiagnostics: [{ messageText: "malformed" }],
      };
    }
    if (isValidJs || isValidTs || isValidTsx) {
      return {
        fileName,
        text,
        kind: "SourceFile",
        statements: [{ kind: 244 }],
        parseDiagnostics: [],
      };
    }
    // Everything else — including valid JS parsed under EXPLICIT
    // ScriptKind.JS (the real workflows-lint.mjs:140 call shape) — gets a
    // degenerate, empty, unwalkable tree.
    return { fileName, text, kind: "SourceFile", statements: [], parseDiagnostics: [] };
  },
  forEachChild(node, cb) {
    for (const s of node.statements ?? []) cb(s);
  },
};
`,
      "utf8",
    );

    const { code, stderr } = await run(driver, [
      JSON.stringify(["createSourceFile", "ScriptTarget", "ScriptKind", "forEachChild"]),
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("CANON ERROR [test-driver]");
  });
});
