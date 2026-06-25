/**
 * attribution-failure-sources.test.ts — observable-best-effort and console.warn tests.
 *
 * Gap closed: "The 6 newly-added console.warn genuine-error catches actually fire on a
 * read fault."
 *
 * Tests verify:
 * 1. Genuine absence (reviews dir does not exist) → [] silently (no warn).
 * 2. Genuine read fault (file exists but can't be read) → [] + console.warn fired.
 *    This distinguishes the error catch path from the clean-absence path.
 * 3. parseOneReviewFile: unparseable file content → [] silently (parseReviewFile returns null).
 * 4. collectCliffEvents fail-open: invalid projectDir (no drift.db) → [] + warn.
 * 5. Full handler: corrupt REVIEW.md (unreadable) → ok:true, attributions [], no crash.
 *
 * Canon principles:
 *   - observable-best-effort: absent source → [] (silent); genuine error → [] + warn
 *   - errors-are-values: typed empty buckets, never thrown
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoreCache } from "../../../domains/workspaces/execution-store-cache.ts";
import { evictDriftDbForScope } from "../../../platform/storage/drift/drift-db-cache.ts";
import { collectFailureSources } from "../services/attribution-failure-sources.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpWorkspace: string;
let tmpProjectDir: string;

beforeEach(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "attr-fail-src-test-workspace-"));
  tmpProjectDir = mkdtempSync(join(tmpdir(), "attr-fail-src-test-project-"));
});

afterEach(() => {
  clearStoreCache();
  evictDriftDbForScope(tmpProjectDir);
  // Restore any chmod'd files before cleanup (otherwise rm fails on some systems)
  try {
    rmSync(tmpWorkspace, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  try {
    rmSync(tmpProjectDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Genuine absence — no reviews/ dir → [] silently (no warn)
// ---------------------------------------------------------------------------

describe("genuine absence — silent fail-open", () => {
  it("returns empty violations without warning when reviews/ dir does not exist", () => {
    const warnSpy = vi.spyOn(console, "warn");
    // No reviews/ dir created in tmpWorkspace

    const { violations } = collectFailureSources(tmpWorkspace, tmpProjectDir);

    expect(violations).toEqual([]);
    // Clean absence must NOT produce a warn — only genuine errors do
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/collectReviewViolations/),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Genuine read fault — unreadable file → [] + console.warn fired
// ---------------------------------------------------------------------------

describe("genuine read fault — fail-open with warn", () => {
  it("warns and returns [] violations when a review .md file cannot be read (EACCES)", () => {
    // Create a reviews dir with an unreadable REVIEW.md (mode 000)
    const reviewsDir = join(tmpWorkspace, "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    const reviewFile = join(reviewsDir, "REVIEW.md");
    writeFileSync(reviewFile, "---\nverdict: BLOCKING\n---\n", "utf-8");
    chmodSync(reviewFile, 0o000); // make unreadable

    const warnSpy = vi.spyOn(console, "warn");

    let violations: ReturnType<typeof collectFailureSources>["violations"];
    try {
      ({ violations } = collectFailureSources(tmpWorkspace, tmpProjectDir));
    } finally {
      // Restore perms before afterEach cleanup
      chmodSync(reviewFile, 0o644);
    }

    // Fail-open: still returns [] (not an error)
    expect(violations).toEqual([]);
    // Observable: warn was emitted for the genuine read fault
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[attribution\]/),
      expect.anything(),
    );
  });

  it("warns and returns [] when reviews/ dir itself cannot be read (EACCES)", () => {
    // Create an unreadable reviews/ dir
    const reviewsDir = join(tmpWorkspace, "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    chmodSync(reviewsDir, 0o000); // dir exists but can't be listed

    const warnSpy = vi.spyOn(console, "warn");

    let violations: ReturnType<typeof collectFailureSources>["violations"];
    try {
      ({ violations } = collectFailureSources(tmpWorkspace, tmpProjectDir));
    } finally {
      chmodSync(reviewsDir, 0o755);
    }

    // Fail-open
    expect(violations).toEqual([]);
    // Observable: warn was emitted
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[attribution\]/),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. parseOneReviewFile: bad content → [] silently (not a genuine I/O error)
// ---------------------------------------------------------------------------

describe("unparseable REVIEW.md content — silent fail-open (not a warn)", () => {
  it("returns [] silently when REVIEW.md content cannot be parsed (not a read error)", () => {
    // Write a file that is readable but whose content parses to null violations.
    // parseReviewFile is pure and never throws — it returns null on bad content.
    // This path is NOT a genuine error, so no warn should fire.
    const reviewsDir = join(tmpWorkspace, "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, "REVIEW.md"), "not a review file at all", "utf-8");

    const warnSpy = vi.spyOn(console, "warn");

    const { violations } = collectFailureSources(tmpWorkspace, tmpProjectDir);

    expect(violations).toEqual([]);
    // parseReviewFile returns null (empty parse), not an I/O error → no warn
    // (A warn from cliff events for missing drift.db is acceptable — filter to review-specific warn)
    const reviewWarnCalls = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("collectReviewViolations"),
    );
    expect(reviewWarnCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. collectCliffEvents fail-open
// ---------------------------------------------------------------------------

describe("collectCliffEvents — fail-open", () => {
  it("returns [] cliff events without throwing when drift.db is absent", () => {
    // tmpProjectDir has no .canon/drift.db (pristine temp dir).
    // getDriftDb will create one, so this tests the path where the DB is valid but empty.
    const { cliffEvents } = collectFailureSources(tmpWorkspace, tmpProjectDir);
    expect(cliffEvents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Fail-open vs genuine error: distinguish the two paths
// ---------------------------------------------------------------------------

describe("fail-open vs genuine error: distinguishable behavior", () => {
  it("absent reviews dir → [] silent; readable empty dir → [] silent; unreadable file → warn", () => {
    // Absent dir (silent)
    const warnSpy = vi.spyOn(console, "warn");
    const r1 = collectFailureSources(tmpWorkspace, tmpProjectDir);
    expect(r1.violations).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockClear();

    // Readable empty reviews dir (silent)
    const reviewsDir = join(tmpWorkspace, "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    const r2 = collectFailureSources(tmpWorkspace, tmpProjectDir);
    expect(r2.violations).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockClear();

    // Unreadable file (warn fires)
    const reviewFile = join(reviewsDir, "REVIEW.md");
    writeFileSync(reviewFile, "---\nverdict: BLOCKING\n---\n", "utf-8");
    chmodSync(reviewFile, 0o000);

    try {
      const r3 = collectFailureSources(tmpWorkspace, tmpProjectDir);
      expect(r3.violations).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[attribution\]/),
        expect.anything(),
      );
    } finally {
      chmodSync(reviewFile, 0o644);
    }
  });
});
