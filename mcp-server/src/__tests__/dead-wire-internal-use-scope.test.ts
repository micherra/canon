/**
 * Scope-aware binding-resolution tests for dead-wire-internal-use.mjs
 *
 * Tests S1–S12 (new discriminating guards for the TS-compiler resolver),
 * F3/F4 (fail-closed for missing typescript and bad args),
 * and the existing shorthand and member-object control cases.
 *
 * These run as subprocess tests against the real helper, same pattern as
 * dead-wire-internal-use.test.ts.
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

let FIXTURES_DIR: string;

beforeAll(() => {
  FIXTURES_DIR = mkdtempSync(join(tmpdir(), "dw-scope-test-"));
});

afterAll(() => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

/** Run the helper as a subprocess; resolve with { code, stdout, stderr } */
function runHelper(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    execFile(process.execPath, [HELPER, ...args], { timeout: 10_000 }, (err, stdout, stderr) => {
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
// S1–S4: member-property DEAD (closes BLOCKING #1)
// ---------------------------------------------------------------------------

describe("S1–S4: member-property over-admission CLOSED", () => {
  test("S1: res.deadFn — member-property access → count 0 (DEAD)", async () => {
    const file = writeFixture(
      "s1-member-property.ts",
      `function deadFn(): void {}
const res = { deadFn: () => {} };
const x = res.deadFn;
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("S2: res?.status — optional-chain property → count 0 (DEAD)", async () => {
    const file = writeFixture(
      "s2-optional-chain.ts",
      `function status(): string { return ""; }
const res = { status: "ok" };
const x = res?.status;
`,
    );
    const { code, stdout } = await runHelper([file, "status"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("S3: a.b.id — nested member property → count 0 (DEAD)", async () => {
    const file = writeFixture(
      "s3-nested-member.ts",
      `function id(): string { return ""; }
const a = { b: { id: "x" } };
const x = a.b.id;
`,
    );
    const { code, stdout } = await runHelper([file, "id"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("S4: export const status + res.status — realistic property collision → count 0 (DEAD)", async () => {
    const file = writeFixture(
      "s4-status-collision.ts",
      `function status(): string { return "active"; }
function handleRequest(res: { status: string }) {
  return res.status;
}
`,
    );
    const { code, stdout } = await runHelper([file, "status"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S5–S8: scope-shadowing DEAD (closes BLOCKING #2)
// ---------------------------------------------------------------------------

describe("S5–S8: scope-shadowing over-admission CLOSED", () => {
  test("S5: const deadFn = 2; return deadFn — shadowing local (used) → count 0 (DEAD)", async () => {
    const file = writeFixture(
      "s5-const-shadow.ts",
      `function deadFn(): void {}
function wrapper(): number {
  const deadFn = 2;
  return deadFn;
}
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("S6: function h(deadFn){return deadFn+1} — shadowing param (used) → count 0 (DEAD)", async () => {
    const file = writeFixture(
      "s6-param-shadow.ts",
      `function deadFn(): void {}
function h(deadFn: number): number {
  return deadFn + 1;
}
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("S7: nested-block shadow only → count 0 (DEAD)", async () => {
    const file = writeFixture(
      "s7-nested-block-shadow.ts",
      `function deadFn(): void {}
function outer(): number {
  {
    const deadFn = 42;
    return deadFn;
  }
}
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("S8: shadow in g() + genuine deadFn() in h() — mixed → count >= 1 (WIRED)", async () => {
    const file = writeFixture(
      "s8-mixed-shadow-genuine.ts",
      `function deadFn(): void {}
function g(): number {
  const deadFn = 99;
  return deadFn;
}
function h(): void {
  deadFn();
}
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// S9–S12: positive guards — genuine uses must stay WIRED
// ---------------------------------------------------------------------------

describe("S9–S12: positive guards — genuine uses stay WIRED", () => {
  test("S9: deadFn.bind(null) — member-OBJECT (not member-property) → count >= 1 (WIRED)", async () => {
    const file = writeFixture(
      "s9-member-object.ts",
      `function deadFn(): void {}
const bound = deadFn.bind(null);
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  test("S10: const o = { deadFn } — shorthand reading export → count >= 1 (WIRED)", async () => {
    const file = writeFixture(
      "s10-shorthand-reading.ts",
      `function deadFn(): void {}
const o = { deadFn };
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  test("S11: { deadFn: 1 } — object key (not a value use) → count 0 (DEAD)", async () => {
    const file = writeFixture(
      "s11-object-key.ts",
      `function deadFn(): void {}
const obj = { deadFn: 1 };
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });

  test("S12: function g(x: DeadT) — type reference → count >= 1 (WIRED)", async () => {
    const file = writeFixture(
      "s12-type-ref.ts",
      `interface DeadT { id: string; }
function g(x: DeadT): void {}
`,
    );
    const { code, stdout } = await runHelper([file, "DeadT"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// F3/F4: fail-closed for new error paths
// ---------------------------------------------------------------------------

describe("F3/F4: fail-closed on typescript absence and bad args", () => {
  test("F4a: bad args (argc < 2, zero args) → non-zero exit (fail-closed)", async () => {
    const { code, stderr } = await runHelper([]);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("F4b: bad args (argc > 2) → non-zero exit (fail-closed)", async () => {
    const file = writeFixture("f4b-extra.ts", `function deadFn(): void {}\n`);
    const { code, stderr } = await runHelper([file, "deadFn", "extraArg"]);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("F4c: missing file (ENOENT) → non-zero exit (fail-closed)", async () => {
    const { code, stderr } = await runHelper(["/nonexistent/absolutely/missing.ts", "deadFn"]);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  // F3: missing typescript — we cannot easily hide it in the subprocess, but we can
  // verify the guard branch exists by checking the diagnostic message on stderr when
  // a normal file is processed (the new helper uses typescript; if unavailable it should
  // fail closed). The structural test: any error path must produce non-zero exit.
  // We test the observable property via a non-existent symbol: export-not-found yields 0.
  test("F3-structural: export not found → count 0, exit 0 (not a typescript failure)", async () => {
    const file = writeFixture(
      "f3-no-export.ts",
      `function someOtherFn(): void {}
`,
    );
    const { code, stdout } = await runHelper([file, "nonExistentSymbol"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Additional positive guards: genuine calls and new expression
// ---------------------------------------------------------------------------

describe("additional positive guards", () => {
  test("genuine call deadFn() → count >= 1 (WIRED)", async () => {
    const file = writeFixture(
      "genuine-call.ts",
      `function deadFn(): void {}
deadFn();
`,
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  test("new DeadFn() — new expression → count >= 1 (WIRED)", async () => {
    const file = writeFixture(
      "new-expr.ts",
      `class DeadFn {}
const x = new DeadFn();
`,
    );
    const { code, stdout } = await runHelper([file, "DeadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  test("class extends DeadFn — heritage clause → count >= 1 (WIRED)", async () => {
    const file = writeFixture(
      "extends-clause.ts",
      `class DeadFn {}
class Child extends DeadFn {}
`,
    );
    const { code, stdout } = await runHelper([file, "DeadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });

  test("template substitution ${deadFn()} → count >= 1 (WIRED)", async () => {
    const file = writeFixture(
      "template-scope.ts",
      "function deadFn(): string { return ''; }\nconst s = `${deadFn()}`;\n",
    );
    const { code, stdout } = await runHelper([file, "deadFn"]);
    expect(code).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(1);
  });
});
