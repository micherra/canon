/**
 * Tests for mcp-server/scripts/dead-wire-internal-use.mjs
 *
 * The helper is invoked as a subprocess (as the gate will invoke it).
 * Tests assert stdout count + exit code for each case from the test plan.
 *
 * These are integration tests that actually parse TypeScript fixture files.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  // With use-position counting, the definition name is excluded.
  // A call is a genuine USE → count ≥ 1.
  // -------------------------------------------------------------------
  test("genuine code use: def + call → count ≥ 1, exit 0 (R1)", async () => {
    const file = writeFixture(
      "genuine-use.ts",
      `export function deadFn(): void {}
const x = deadFn();
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Comment-only mention → should NOT count as a code reference.
  // With use-position counting, the def name is also excluded, so count = 0.
  // -------------------------------------------------------------------
  test("block-comment-only mention → count = 0 (def excluded, comment excluded), exit 0 (bypass f1)", async () => {
    const file = writeFixture(
      "f1-block-comment.ts",
      `export function deadFn(): void {}
/* deadFn */
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0); // def name excluded, comment excluded
  });

  test("line-comment-only mention → count = 0 (def excluded, comment excluded), exit 0 (bypass f5 variant)", async () => {
    const file = writeFixture(
      "f5-line-comment.ts",
      `export function deadFn(): void {}
// deadFn
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("comment-inside-string → count = 0 (def excluded, string excluded), exit 0 (bypass f3)", async () => {
    const file = writeFixture(
      "f3-comment-in-string.ts",
      `export function deadFn(): void {}
const s = "/* deadFn */";
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("string-literal-only mention → count = 0 (def excluded, string excluded), exit 0", async () => {
    const file = writeFixture(
      "string-literal.ts",
      `export function deadFn(): void {}
const s = "deadFn";
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("regex-only mention → count = 0 (def excluded, regex excluded), exit 0 (bypass f4)", async () => {
    const file = writeFixture(
      "f4-regex.ts",
      `export function deadFn(): void {}
const r = /deadFn/;
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  // -------------------------------------------------------------------
  // Template substitution — MUST count as a code reference (f7)
  // With use-position counting: def name excluded, call in template counted.
  // count ≥ 1.
  // -------------------------------------------------------------------
  test("template substitution ${deadFn()} → count ≥ 1, exit 0 (bypass f7)", async () => {
    const file = writeFixture(
      "f7-template-sub.ts",
      "export function deadFn(): string { return ''; }\nconst s = `${deadFn()}`;\n",
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Zero genuine uses (def only) — R2
  // With use-position counting: def name excluded → count = 0.
  // Gate receives 0 → DEAD (correct behavior preserved).
  // -------------------------------------------------------------------
  test("def only, zero genuine uses → count = 0, exit 0 (R2)", async () => {
    const file = writeFixture(
      "def-only.ts",
      `export function deadFn(): void {}
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
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

  test("non-existent input file → non-zero exit (fail-closed)", async () => {
    // New TS-compiler resolver: missing file → readFileSync throws → non-zero exit
    const { code, stderr } = await runHelper(["/nonexistent/path/missing-file.ts", "deadFn"]);
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
  // def name excluded, call counted → count ≥ 1
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
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Multi-declaration false-WIRE tests (use-position counting fix)
  //
  // Each of these forms has multiple declaration-name occurrences of the
  // symbol but ZERO genuine uses. With use-position counting the helper
  // must return count = 0 for each.
  // -------------------------------------------------------------------

  test("overloaded function: 2 signatures + impl, zero uses → use-count 0, exit 0 (DEAD)", async () => {
    const file = writeFixture(
      "overload-dead.ts",
      `function overloadFn(x: string): string;
function overloadFn(x: number): number;
function overloadFn(x: string | number): string | number { return x; }
`,
    );
    const { code, stdout } = await runHelper([file, "overloadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("overloaded function + genuine call → use-count ≥ 1, exit 0 (WIRED)", async () => {
    const file = writeFixture(
      "overload-wired.ts",
      `function overloadFn(x: string): string;
function overloadFn(x: number): number;
function overloadFn(x: string | number): string | number { return x; }
const result = overloadFn("hello");
`,
    );
    const { code, stdout } = await runHelper([file, "overloadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  test("export type + export const (declaration merge), zero uses → use-count 0, exit 0 (DEAD)", async () => {
    const file = writeFixture(
      "type-const-dead.ts",
      `type MergedName = string;
const MergedName = "value";
`,
    );
    const { code, stdout } = await runHelper([file, "MergedName"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("export type + export const + genuine use → use-count ≥ 1, exit 0 (WIRED)", async () => {
    const file = writeFixture(
      "type-const-wired.ts",
      `type MergedName = string;
const MergedName = "value";
const x: MergedName = MergedName;
`,
    );
    const { code, stdout } = await runHelper([file, "MergedName"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  test("export interface + export const (declaration merge), zero uses → use-count 0, exit 0 (DEAD)", async () => {
    const file = writeFixture(
      "iface-const-dead.ts",
      `interface IfaceConst { id: string; }
const IfaceConst = { id: "x" };
`,
    );
    const { code, stdout } = await runHelper([file, "IfaceConst"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("export interface + export const + genuine use → use-count ≥ 1, exit 0 (WIRED)", async () => {
    const file = writeFixture(
      "iface-const-wired.ts",
      `interface IfaceConst { id: string; }
const IfaceConst = { id: "x" };
const x: IfaceConst = IfaceConst;
`,
    );
    const { code, stdout } = await runHelper([file, "IfaceConst"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  test("export interface + export class (declaration merge), zero uses → use-count 0, exit 0 (DEAD)", async () => {
    const file = writeFixture(
      "iface-class-dead.ts",
      `interface IfaceClass { id: string; }
class IfaceClass { id = "x"; }
`,
    );
    const { code, stdout } = await runHelper([file, "IfaceClass"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("export interface + export class + genuine use → use-count ≥ 1, exit 0 (WIRED)", async () => {
    const file = writeFixture(
      "iface-class-wired.ts",
      `interface IfaceClass { id: string; }
class IfaceClass { id = "x"; }
const obj: IfaceClass = new IfaceClass();
`,
    );
    const { code, stdout } = await runHelper([file, "IfaceClass"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  test("export function + export namespace (declaration merge), zero uses → use-count 0, exit 0 (DEAD)", async () => {
    const file = writeFixture(
      "fn-namespace-dead.ts",
      `function FnNs(): void {}
namespace FnNs { export const version = 1; }
`,
    );
    const { code, stdout } = await runHelper([file, "FnNs"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("export function + export namespace + genuine use → use-count ≥ 1, exit 0 (WIRED)", async () => {
    const file = writeFixture(
      "fn-namespace-wired.ts",
      `function FnNs(): void {}
namespace FnNs { export const version = 1; }
FnNs();
`,
    );
    const { code, stdout } = await runHelper([file, "FnNs"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Single def → use-count 0 (regression guard: previous logic gave count=1)
  // With use-position counting: def name is excluded, so count = 0 for
  // a symbol with only its own declaration and no genuine uses.
  // -------------------------------------------------------------------
  test("single export function def only → use-count 0, exit 0 (DEAD)", async () => {
    const file = writeFixture(
      "single-def-only.ts",
      `export function singleDeadFn(): void {}
`,
    );
    const { code, stdout } = await runHelper([file, "singleDeadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("single export function def + call → use-count ≥ 1, exit 0 (WIRED)", async () => {
    const file = writeFixture(
      "single-def-wired.ts",
      `export function singleDeadFn(): void {}
singleDeadFn();
`,
    );
    const { code, stdout } = await runHelper([file, "singleDeadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // FALSE-WIRE leak forms (reviewer-confirmed) — must resolve count = 0
  //
  // These are the 6 forms the adversarial reviewer confirmed were leaking
  // under the old denylist posture (counted as uses, returned count >= 1).
  // Under the new USE-POSITION ALLOWLIST they must all return count = 0.
  // -------------------------------------------------------------------

  // Leak 1: object property KEY `{ deadFn: 1 }` — NOT a use
  test("property KEY { deadFn: 1 } → count = 0, exit 0 (DEAD) — Leak 1", async () => {
    const file = writeFixture(
      "leak1-property-key.ts",
      `export function deadFn(): void {}
const obj = { deadFn: 1 };
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  // Realistic collision: `export const status` + `{ status: "ok" }` must be DEAD
  test("export const status + { status: 'ok' } property key collision → count = 0 (DEAD) — Leak 1 realistic", async () => {
    const file = writeFixture(
      "leak1-status-collision.ts",
      `export const status = "active";
const response = { status: "ok" };
`,
    );
    const { code, stdout } = await runHelper([file, "status"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  // Leak 2: enum member `enum E { deadFn }` — NOT a use
  test("enum member `enum E { deadFn }` → count = 0, exit 0 (DEAD) — Leak 2", async () => {
    const file = writeFixture(
      "leak2-enum-member.ts",
      `export function deadFn(): void {}
enum E { deadFn }
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  // Leak 3: array destructure binding `const [deadFn] = x` — NOT a use
  test("array destructure binding `const [deadFn] = x` → count = 0, exit 0 (DEAD) — Leak 3", async () => {
    const file = writeFixture(
      "leak3-array-destr.ts",
      `export function deadFn(): void {}
const someArray: (() => void)[] = [];
const [deadFn] = someArray;
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  // Leak 4: renamed destructure binding `const { x: deadFn } = y` — NOT a use
  test("renamed destructure binding `const { x: deadFn } = y` → count = 0, exit 0 (DEAD) — Leak 4", async () => {
    const file = writeFixture(
      "leak4-renamed-destr.ts",
      `export function deadFn(): void {}
const source = { x: (): void => {} };
const { x: deadFn } = source;
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  // Leak 5: export specifier `export { deadFn }` (re-export) — NOT an internal use
  test("export specifier `export { deadFn }` → count = 0, exit 0 (DEAD) — Leak 5", async () => {
    const file = writeFixture(
      "leak5-export-specifier.ts",
      `export function deadFn(): void {}
export { deadFn };
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  // Leak 6: re-export from module `export { deadFn } from './m'` — NOT a use
  test("re-export from module `export { deadFn } from './m'` → count = 0, exit 0 (DEAD) — Leak 6", async () => {
    const file = writeFixture(
      "leak6-reexport.ts",
      `export function deadFn(): void {}
export { deadFn } from './other-module';
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  // -------------------------------------------------------------------
  // FAIL-CLOSED DEFAULT: unrecognized AST position → NON-use → count = 0
  //
  // This proves the allowlist posture: an identifier in a position NOT
  // in the recognized-use allowlist defaults to NON-use (DEAD). We use
  // a labeled statement position which is uncommon and not in the allowlist.
  // Under the old denylist, this would have been counted as a use.
  // Under the new allowlist, any unrecognized position → NOT counted.
  // -------------------------------------------------------------------
  test("fail-closed-default: identifier in parameter binding position → count = 0 (NON-use default)", async () => {
    // Parameter binding is not a USE (it's a binding site). The symbol
    // appears only as a function parameter name and in its declaration.
    // An allowlist that doesn't include param-binding positions defaults to 0.
    const file = writeFixture(
      "fail-closed-default.ts",
      `export function deadFn(): void {}
function wrapper(deadFn: () => void): void { return; }
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  // -------------------------------------------------------------------
  // Attack-2 preserved: shorthand object EXPRESSION { deadFn } IS a use
  // (reading the binding value, not a key-only property like { deadFn: 1 })
  // -------------------------------------------------------------------
  test("shorthand object expression { deadFn } → count ≥ 1 (genuine use) — Attack-2 regression guard", async () => {
    const file = writeFixture(
      "shorthand-obj-expr.ts",
      `export function deadFn(): void {}
const obj = { deadFn };
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });
});
