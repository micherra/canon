/**
 * File claims tests — .canon/claims.json management
 *
 * Uses real temp directories for I/O correctness.
 * Tests cover: readClaims, writeClaims, registerClaims, releaseClaims, checkClaimOverlaps.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  checkClaimOverlaps,
  readClaims,
  registerClaims,
  releaseClaims,
  writeClaims,
} from "../file-claims.ts";

/** Write a claims file directly (bypassing writeClaims) for test setup. */
function seedClaimsFile(projectDir: string, data: unknown): void {
  mkdirSync(join(projectDir, ".canon"), { recursive: true });
  writeFileSync(join(projectDir, ".canon", "claims.json"), JSON.stringify(data), "utf-8");
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "file-claims-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

// readClaims

describe("readClaims", () => {
  test("returns empty structure when file doesn't exist", () => {
    const result = readClaims(tmpDir);
    expect(result.version).toBe(1);
    expect(result.claims).toEqual({});
  });

  test("prunes entries older than 24h", () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const freshDate = new Date().toISOString();
    seedClaimsFile(tmpDir, {
      claims: {
        "src/foo.ts": [
          { claimed_at: staleDate, workflow: "stale-wf" },
          { claimed_at: freshDate, workflow: "fresh-wf" },
        ],
      },
      version: 1,
    });

    const result = readClaims(tmpDir);
    expect(result.claims["src/foo.ts"]).toHaveLength(1);
    expect(result.claims["src/foo.ts"][0].workflow).toBe("fresh-wf");
  });

  test("removes file keys with empty claim arrays after pruning", () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    seedClaimsFile(tmpDir, {
      claims: {
        "src/all-stale.ts": [{ claimed_at: staleDate, workflow: "stale-wf" }],
      },
      version: 1,
    });

    const result = readClaims(tmpDir);
    expect(result.claims["src/all-stale.ts"]).toBeUndefined();
    expect(Object.keys(result.claims)).toHaveLength(0);
  });

  test("returns empty structure on corrupt JSON", () => {
    mkdirSync(join(tmpDir, ".canon"), { recursive: true });
    writeFileSync(join(tmpDir, ".canon", "claims.json"), "{ not valid json }", "utf-8");

    const result = readClaims(tmpDir);
    expect(result.version).toBe(1);
    expect(result.claims).toEqual({});
  });

  test("returns empty structure on wrong version", () => {
    seedClaimsFile(tmpDir, { claims: { "src/foo.ts": [] }, version: 2 });

    const result = readClaims(tmpDir);
    expect(result.version).toBe(1);
    expect(result.claims).toEqual({});
  });
});

// writeClaims

describe("writeClaims", () => {
  test("creates .canon/ directory if missing", () => {
    const claims = { claims: {}, version: 1 as const };
    writeClaims(tmpDir, claims);

    expect(existsSync(join(tmpDir, ".canon", "claims.json"))).toBe(true);
  });

  test("writes claims atomically (file is present and readable after write)", () => {
    const freshDate = new Date().toISOString();
    const claims = {
      claims: {
        "src/foo.ts": [{ claimed_at: freshDate, workflow: "my-wf" }],
      },
      version: 1 as const,
    };
    writeClaims(tmpDir, claims);

    const result = readClaims(tmpDir);
    expect(result.claims["src/foo.ts"]).toHaveLength(1);
    expect(result.claims["src/foo.ts"][0].workflow).toBe("my-wf");
  });
});

// registerClaims

describe("registerClaims", () => {
  test("adds entries for new files", () => {
    registerClaims(tmpDir, "wf-a", ["src/foo.ts", "src/bar.ts"]);

    const result = readClaims(tmpDir);
    expect(result.claims["src/foo.ts"]).toHaveLength(1);
    expect(result.claims["src/foo.ts"][0].workflow).toBe("wf-a");
    expect(result.claims["src/bar.ts"]).toHaveLength(1);
  });

  test("is idempotent — no duplicates when registering same workflow+file again", () => {
    registerClaims(tmpDir, "wf-a", ["src/foo.ts"]);
    registerClaims(tmpDir, "wf-a", ["src/foo.ts"]);

    const result = readClaims(tmpDir);
    expect(result.claims["src/foo.ts"]).toHaveLength(1);
  });

  test("preserves existing claims from other workflows", () => {
    registerClaims(tmpDir, "wf-a", ["src/foo.ts"]);
    registerClaims(tmpDir, "wf-b", ["src/foo.ts"]);

    const result = readClaims(tmpDir);
    expect(result.claims["src/foo.ts"]).toHaveLength(2);
    const workflows = result.claims["src/foo.ts"].map((e) => e.workflow);
    expect(workflows).toContain("wf-a");
    expect(workflows).toContain("wf-b");
  });
});

// releaseClaims

describe("releaseClaims", () => {
  test("removes all entries for a workflow", () => {
    registerClaims(tmpDir, "wf-a", ["src/foo.ts", "src/bar.ts"]);
    registerClaims(tmpDir, "wf-b", ["src/foo.ts"]);
    releaseClaims(tmpDir, "wf-a");

    const result = readClaims(tmpDir);
    // wf-a entries removed; wf-b still present on foo
    const fooEntries = result.claims["src/foo.ts"] ?? [];
    expect(fooEntries.every((e) => e.workflow !== "wf-a")).toBe(true);
    expect(fooEntries.some((e) => e.workflow === "wf-b")).toBe(true);
    // bar had only wf-a, so its key should be absent
    expect(result.claims["src/bar.ts"]).toBeUndefined();
  });

  test("is a no-op for unknown workflow", () => {
    registerClaims(tmpDir, "wf-a", ["src/foo.ts"]);
    releaseClaims(tmpDir, "wf-unknown");

    const result = readClaims(tmpDir);
    expect(result.claims["src/foo.ts"]).toHaveLength(1);
  });
});

// checkClaimOverlaps

describe("checkClaimOverlaps", () => {
  test("returns overlapping files from other workflows", () => {
    registerClaims(tmpDir, "wf-a", ["src/foo.ts", "src/bar.ts"]);
    const overlaps = checkClaimOverlaps(tmpDir, "wf-b", ["src/foo.ts", "src/baz.ts"]);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].file_path).toBe("src/foo.ts");
    expect(overlaps[0].workflows).toContain("wf-a");
  });

  test("ignores claims from the same workflow", () => {
    registerClaims(tmpDir, "wf-a", ["src/foo.ts"]);
    const overlaps = checkClaimOverlaps(tmpDir, "wf-a", ["src/foo.ts"]);

    expect(overlaps).toHaveLength(0);
  });

  test("returns empty array when no overlaps", () => {
    registerClaims(tmpDir, "wf-a", ["src/foo.ts"]);
    const overlaps = checkClaimOverlaps(tmpDir, "wf-b", ["src/bar.ts", "src/baz.ts"]);

    expect(overlaps).toHaveLength(0);
  });
});
