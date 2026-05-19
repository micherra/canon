/**
 * progressive-disclosure.test.ts — Tests for applyDisclosure
 *
 * Tests cover:
 * 1. Under-threshold passthrough — returns data unchanged, no file written
 * 2. Over-threshold truncation — returns summary + file pointer, writes file
 * 3. Custom threshold (low) — small data triggers truncation
 * 4. Custom threshold (high) — large data passes through
 * 5. File pointer format — full_data_path ends with "{prefix}-{8-hex}.json"
 * 6. Summary function called — receives original data, result appears in summary field
 * 7. Deterministic filenames — same data+prefix → same name; different data → different name
 * 8. Directory creation — works when outputDir does not yet exist
 * 9. File content roundtrip — written file parses back to original data
 * 10. byte_size matches actual file size on disk
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDisclosure, DEFAULT_DISCLOSURE_THRESHOLD } from "../progressive-disclosure.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a string that is `n` characters long. */
const makeString = (n: number): string => "x".repeat(n);

/** Build an object whose JSON serialization exceeds `n` characters. */
const makeLargeData = (n: number): Record<string, string> => ({ payload: makeString(n) });

// ── setup ─────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `pd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { force: true, recursive: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("applyDisclosure", () => {
  describe("DEFAULT_DISCLOSURE_THRESHOLD", () => {
    it("is 12_000", () => {
      expect(DEFAULT_DISCLOSURE_THRESHOLD).toBe(12_000);
    });
  });

  describe("under-threshold passthrough", () => {
    it("returns { truncated: false, data } for small payloads", () => {
      const data = { message: "hello" };
      const result = applyDisclosure(data, {
        filePrefix: "test",
        outputDir: tmpDir,
        summarize: () => "summary",
        threshold: 100,
      });

      expect(result.truncated).toBe(false);
      if (!result.truncated) {
        expect(result.data).toEqual(data);
      }
    });

    it("does not write any file when under threshold", () => {
      const filesBefore = existsSync(tmpDir) ? require("node:fs").readdirSync(tmpDir) : [];

      applyDisclosure(
        { tiny: true },
        {
          filePrefix: "test",
          outputDir: tmpDir,
          summarize: () => "s",
          threshold: 10_000,
        },
      );

      const filesAfter = require("node:fs").readdirSync(tmpDir);
      expect(filesAfter.length).toBe(filesBefore.length);
    });

    it("uses DEFAULT_DISCLOSURE_THRESHOLD when threshold is omitted", () => {
      // Data just under default threshold passes through
      const data = { v: makeString(DEFAULT_DISCLOSURE_THRESHOLD - 20) };
      const serialized = JSON.stringify(data);
      expect(serialized.length).toBeLessThanOrEqual(DEFAULT_DISCLOSURE_THRESHOLD);

      const result = applyDisclosure(data, {
        filePrefix: "test",
        outputDir: tmpDir,
        summarize: () => "s",
      });
      expect(result.truncated).toBe(false);
    });
  });

  describe("over-threshold truncation", () => {
    it("returns { truncated: true, summary, full_data_path, byte_size } for large payloads", () => {
      const data = makeLargeData(200);
      const result = applyDisclosure(data, {
        filePrefix: "fc",
        outputDir: tmpDir,
        summarize: (d) => `keys: ${Object.keys(d).join(",")}`,
        threshold: 10,
      });

      expect(result.truncated).toBe(true);
      if (result.truncated) {
        expect(result.summary).toBe("keys: payload");
        expect(result.full_data_path).toBeTruthy();
        expect(result.byte_size).toBeGreaterThan(0);
      }
    });

    it("writes the full payload to disk at the returned path", () => {
      const data = makeLargeData(200);
      const result = applyDisclosure(data, {
        filePrefix: "fc",
        outputDir: tmpDir,
        summarize: () => "s",
        threshold: 10,
      });

      expect(result.truncated).toBe(true);
      if (result.truncated) {
        expect(existsSync(result.full_data_path)).toBe(true);
      }
    });

    it("written file round-trips back to original data", () => {
      const data = { nested: { a: 1, b: [2, 3] }, top: "level" };
      const result = applyDisclosure(data, {
        filePrefix: "rt",
        outputDir: tmpDir,
        summarize: () => "s",
        threshold: 10,
      });

      expect(result.truncated).toBe(true);
      if (result.truncated) {
        const raw = readFileSync(result.full_data_path, "utf-8");
        expect(JSON.parse(raw)).toEqual(data);
      }
    });

    it("byte_size matches the actual byte length of the file on disk", () => {
      const data = makeLargeData(300);
      const result = applyDisclosure(data, {
        filePrefix: "bs",
        outputDir: tmpDir,
        summarize: () => "s",
        threshold: 10,
      });

      expect(result.truncated).toBe(true);
      if (result.truncated) {
        const stat = statSync(result.full_data_path);
        expect(result.byte_size).toBe(stat.size);
      }
    });
  });

  describe("custom threshold", () => {
    it("threshold of 10 triggers truncation on small data", () => {
      const data = { x: "hello world" }; // JSON > 10 chars
      const result = applyDisclosure(data, {
        filePrefix: "small",
        outputDir: tmpDir,
        summarize: () => "short",
        threshold: 10,
      });
      expect(result.truncated).toBe(true);
    });

    it("threshold of 1_000_000 passes large data through", () => {
      const data = makeLargeData(5_000);
      const result = applyDisclosure(data, {
        filePrefix: "big",
        outputDir: tmpDir,
        summarize: () => "s",
        threshold: 1_000_000,
      });
      expect(result.truncated).toBe(false);
    });

    it("exactly at threshold passes through (<=, not <)", () => {
      const data = { v: "a" };
      const serialized = JSON.stringify(data);
      const result = applyDisclosure(data, {
        filePrefix: "exact",
        outputDir: tmpDir,
        summarize: () => "s",
        threshold: serialized.length, // exact match
      });
      expect(result.truncated).toBe(false);
    });
  });

  describe("file pointer format", () => {
    it("full_data_path ends with '{filePrefix}-{8-char-hex}.json'", () => {
      const data = makeLargeData(200);
      const result = applyDisclosure(data, {
        filePrefix: "file-context",
        outputDir: tmpDir,
        summarize: () => "s",
        threshold: 10,
      });

      expect(result.truncated).toBe(true);
      if (result.truncated) {
        const filename = result.full_data_path.split("/").pop()!;
        expect(filename).toMatch(/^file-context-[0-9a-f]{8}\.json$/);
      }
    });

    it("full_data_path is inside outputDir", () => {
      const data = makeLargeData(200);
      const result = applyDisclosure(data, {
        filePrefix: "ctx",
        outputDir: tmpDir,
        summarize: () => "s",
        threshold: 10,
      });

      expect(result.truncated).toBe(true);
      if (result.truncated) {
        expect(result.full_data_path.startsWith(tmpDir)).toBe(true);
      }
    });
  });

  describe("summary function", () => {
    it("calls summarize with the original data", () => {
      let capturedData: unknown = null;
      const data = makeLargeData(200);

      applyDisclosure(data, {
        filePrefix: "sum",
        outputDir: tmpDir,
        summarize: (d) => {
          capturedData = d;
          return "captured";
        },
        threshold: 10,
      });

      expect(capturedData).toEqual(data);
    });

    it("includes the summarize return value in the result summary field", () => {
      const data = makeLargeData(200);
      const result = applyDisclosure(data, {
        filePrefix: "sum",
        outputDir: tmpDir,
        summarize: () => "my custom summary text",
        threshold: 10,
      });

      expect(result.truncated).toBe(true);
      if (result.truncated) {
        expect(result.summary).toBe("my custom summary text");
      }
    });
  });

  describe("deterministic filenames", () => {
    it("same data + same prefix produces the same filename", () => {
      const data = makeLargeData(200);
      const opts = {
        filePrefix: "det",
        outputDir: tmpDir,
        summarize: () => "s",
        threshold: 10,
      } as const;

      const r1 = applyDisclosure(data, opts);
      const r2 = applyDisclosure(data, opts);

      expect(r1.truncated).toBe(true);
      expect(r2.truncated).toBe(true);
      if (r1.truncated && r2.truncated) {
        expect(r1.full_data_path).toBe(r2.full_data_path);
      }
    });

    it("different data produces different filenames", () => {
      const r1 = applyDisclosure(makeLargeData(200), {
        filePrefix: "det",
        outputDir: tmpDir,
        summarize: () => "s",
        threshold: 10,
      });
      const r2 = applyDisclosure(makeLargeData(201), {
        filePrefix: "det",
        outputDir: tmpDir,
        summarize: () => "s",
        threshold: 10,
      });

      expect(r1.truncated).toBe(true);
      expect(r2.truncated).toBe(true);
      if (r1.truncated && r2.truncated) {
        expect(r1.full_data_path).not.toBe(r2.full_data_path);
      }
    });
  });

  describe("directory creation", () => {
    it("creates outputDir when it does not yet exist", () => {
      const nonExistentDir = join(tmpDir, "nested", "subdir");
      expect(existsSync(nonExistentDir)).toBe(false);

      const result = applyDisclosure(makeLargeData(200), {
        filePrefix: "mkdir",
        outputDir: nonExistentDir,
        summarize: () => "s",
        threshold: 10,
      });

      expect(result.truncated).toBe(true);
      if (result.truncated) {
        expect(existsSync(result.full_data_path)).toBe(true);
      }
    });
  });
});
