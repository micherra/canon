/**
 * `appendJsonlLine` — newline-safe JSONL append primitive.
 *
 * Uses real temp directories for I/O correctness (mkdtemp per test, never
 * the repo's real `.canon/` — the global `drift-db-leak-guard` fails the
 * suite on writes to the live store).
 *
 * The load-bearing case (AC#2) is the predecessor-merge regression: a
 * newline-less predecessor left by a historical or bypassing writer must be
 * healed, not merged onto. See PROBE-FINDINGS.md P1 for the reproduction
 * this regression test encodes.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendJsonlLine } from "../jsonl-append.ts";

let tmpDir: string;
let jsonlPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "jsonl-append-test-"));
  jsonlPath = join(tmpDir, "learning.jsonl");
});

afterEach(async () => {
  await rm(tmpDir, { force: true, recursive: true });
});

function parseableLines(raw: string): unknown[] {
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

describe("appendJsonlLine", () => {
  it("AC#2 (load-bearing): heals a newline-less predecessor instead of merging onto it", async () => {
    // Predecessor omits its trailing newline — the historical bug.
    await writeFile(jsonlPath, JSON.stringify({ run_id: "A" }), "utf-8");

    const result = await appendJsonlLine(jsonlPath, { run_id: "B" });

    expect(result.healed).toBe(true);
    const raw = await readFile(jsonlPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(parseableLines(raw)).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ run_id: "A" });
    expect(JSON.parse(lines[1])).toEqual({ run_id: "B" });
  });

  it('control: the naive appendFile(line + "\\n") idiom corrupts on the same seed (documents what we fixed)', async () => {
    const { appendFile } = await import("node:fs/promises");
    await writeFile(jsonlPath, JSON.stringify({ run_id: "A" }), "utf-8");
    await appendFile(jsonlPath, `${JSON.stringify({ run_id: "B" })}\n`, "utf-8");

    const raw = await readFile(jsonlPath, "utf-8");
    expect(parseableLines(raw)).toHaveLength(0);
  });

  it("throws when the serialized line embeds a raw newline", async () => {
    // JSON.stringify's own escaping means no legitimate JS record ever
    // produces a raw \n in its output (a "\n" string value serializes to
    // the two-char escape \\n, not a real newline byte) — so the guard's
    // natural trigger is unreachable through ordinary use. It exists as a
    // structural invariant (a JSONL record is single-line by definition)
    // rather than a reachable-today input validator, so this test forces
    // the branch via a spy to prove the guard itself is wired correctly.
    const spy = vi.spyOn(JSON, "stringify").mockReturnValueOnce('{"a":"line one\nline two"}');
    await expect(appendJsonlLine(jsonlPath, { a: "irrelevant" })).rejects.toThrow(/single-line/);
    spy.mockRestore();

    // File must be untouched — the throw happens before any fs access.
    await expect(readFile(jsonlPath, "utf-8")).rejects.toThrow();
  });

  it("missing file: creates it with 1 line, healed: false", async () => {
    const result = await appendJsonlLine(jsonlPath, { run_id: "X" });
    expect(result.healed).toBe(false);
    const raw = await readFile(jsonlPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ run_id: "X" });
  });

  it("repeated appends: N records yield N parseable lines", async () => {
    for (let i = 0; i < 5; i++) {
      await appendJsonlLine(jsonlPath, { i });
    }
    const raw = await readFile(jsonlPath, "utf-8");
    expect(parseableLines(raw)).toHaveLength(5);
  });

  it("concurrent appends: N records yield N parseable lines (locks P4 in as a standing assertion)", async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => appendJsonlLine(jsonlPath, { i })));
    const raw = await readFile(jsonlPath, "utf-8");
    expect(parseableLines(raw)).toHaveLength(50);
  });
});
