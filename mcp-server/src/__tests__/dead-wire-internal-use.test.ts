/**
 * Tests for mcp-server/scripts/dead-wire-internal-use.mjs
 *
 * The helper is invoked as a subprocess (as the gate will invoke it).
 * Tests assert stdout count + exit code for each case from the test plan.
 *
 * These are integration tests that actually parse TypeScript fixture files.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const HELPER = resolve(
  fileURLToPath(import.meta.url),
  // __tests__ -> src -> mcp-server -> scripts/dead-wire-internal-use.mjs
  "../../../scripts/dead-wire-internal-use.mjs",
);

// Fixtures directory — created fresh for this test run, torn down after
let FIXTURES_DIR: string;

beforeAll(() => {
  FIXTURES_DIR = mkdtempSync(join(tmpdir(), "dw-test-"));
});

afterAll(() => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

/** Run the helper as a subprocess; resolve with { code, stdout, stderr } */
function runHelper(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    execFile(process.execPath, [HELPER, ...args], { timeout: 10_000 }, (err, stdout, stderr) => {
      // err.code is `string | number | undefined`; exitCode is `number | null`
      const code = typeof err?.code === "number" ? err.code : err?.code ? 1 : 0;
      resolveP({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

/** Write a TypeScript fixture to FIXTURES_DIR; return its path. */
function writeFixture(name: string, content: string): string {
  const p = join(FIXTURES_DIR, name);
  writeFileSync(p, content, "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("dead-wire-internal-use.mjs — subprocess tests", () => {
  // -------------------------------------------------------------------
  // Happy path: genuine code references
  // -------------------------------------------------------------------
  test("genuine code use: def + call → count ≥ 2, exit 0 (R1)", async () => {
    const file = writeFixture(
      "genuine-use.ts",
      `export function deadFn(): void {}
const x = deadFn();
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------
  // Comment-only mention → should NOT count as a code reference
  // -------------------------------------------------------------------
  test("block-comment-only mention → count = 1 (def only), exit 0 (bypass f1)", async () => {
    const file = writeFixture(
      "f1-block-comment.ts",
      `export function deadFn(): void {}
/* deadFn */
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(1); // only the definition
  });

  test("line-comment-only mention → count = 1 (def only), exit 0 (bypass f5 variant)", async () => {
    const file = writeFixture(
      "f5-line-comment.ts",
      `export function deadFn(): void {}
// deadFn
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(1);
  });

  test("comment-inside-string → count = 1 (def only), exit 0 (bypass f3)", async () => {
    const file = writeFixture(
      "f3-comment-in-string.ts",
      `export function deadFn(): void {}
const s = "/* deadFn */";
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(1);
  });

  test("string-literal-only mention → count = 1 (def only), exit 0", async () => {
    const file = writeFixture(
      "string-literal.ts",
      `export function deadFn(): void {}
const s = "deadFn";
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(1);
  });

  test("regex-only mention → count = 1 (def only), exit 0 (bypass f4)", async () => {
    const file = writeFixture(
      "f4-regex.ts",
      `export function deadFn(): void {}
const r = /deadFn/;
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(1);
  });

  // -------------------------------------------------------------------
  // Template substitution — MUST count as a code reference (f7)
  // -------------------------------------------------------------------
  test("template substitution ${deadFn()} → count ≥ 2, exit 0 (bypass f7)", async () => {
    const file = writeFixture(
      "f7-template-sub.ts",
      "export function deadFn(): string { return ''; }\nconst s = `${deadFn()}`;\n",
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------
  // Zero-reference (def only) — R2
  // -------------------------------------------------------------------
  test("def only, zero other references → count = 1, exit 0 (R2)", async () => {
    const file = writeFixture(
      "def-only.ts",
      `export function deadFn(): void {}
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(1);
  });

  // -------------------------------------------------------------------
  // Symbol not present at all → count = 0, exit 0
  // -------------------------------------------------------------------
  test("symbol not in file → count = 0, exit 0", async () => {
    const file = writeFixture(
      "no-symbol.ts",
      `export function someOtherFn(): void {}
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  // -------------------------------------------------------------------
  // Fail-closed paths — all must exit non-zero
  // -------------------------------------------------------------------
  test("missing file → non-zero exit (fail-closed)", async () => {
    const { code, stderr } = await runHelper(["/nonexistent/file.ts", "deadFn"]);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0); // diagnostic emitted
  });

  test("wrong argc (too few args) → non-zero exit (fail-closed)", async () => {
    const { code, stderr } = await runHelper([]);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("wrong argc (too many args) → non-zero exit (fail-closed)", async () => {
    const file = writeFixture("extra-args.ts", `export function deadFn(): void {}\n`);
    const { code, stderr } = await runHelper([file, "deadFn", "extraArg"]);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("bad/missing grammar path via env override → non-zero exit (fail-closed)", async () => {
    // We point the grammar at a temp dir that has no wasm files
    const emptyGrammarsDir = join(FIXTURES_DIR, "empty-grammars");
    mkdirSync(emptyGrammarsDir, { recursive: true });
    const file = writeFixture("gram-test.ts", `export function deadFn(): void {}\n`);

    const { code, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolveP) => {
        execFile(
          process.execPath,
          [HELPER, file, "deadFn"],
          {
            timeout: 10_000,
            env: { ...process.env, DEAD_WIRE_GRAMMARS_DIR: emptyGrammarsDir },
          },
          (err, stdout, stderr) => {
            const code = typeof err?.code === "number" ? err.code : err?.code ? 1 : 0;
            resolveP({ code, stdout: stdout.trim(), stderr: stderr.trim() });
          },
        );
      },
    );

    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // Confirms the helper runs without ERR_MODULE_NOT_FOUND
  // (Validates module resolution under mcp-server/)
  // -------------------------------------------------------------------
  test("helper starts without module resolution errors", async () => {
    // A test that would fail first if web-tree-sitter can't be resolved
    const file = writeFixture("module-check.ts", `export const x = 1;\n`);
    const { stderr } = await runHelper([file, "x"]);
    expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(stderr).not.toContain("Cannot find package");
  });

  // -------------------------------------------------------------------
  // .tsx files parsed with tsx grammar (no error)
  // -------------------------------------------------------------------
  test("tsx file extension uses tsx grammar → exit 0", async () => {
    const file = writeFixture(
      "component.tsx",
      `export function deadFn(): JSX.Element { return <div />; }
const x = deadFn();
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(2);
  });
});
