/**
 * Tests for ensureGraphFresh — the lazy commit-granularity KG freshness gate.
 *
 * The gate reads meta.graph_head_commit, compares against getCurrentHead, and
 * runs runPipeline (incremental — which prunes + re-stamps) on mismatch. It is
 * fail-open: any git/pipeline error logs a warning and returns (never throws).
 *
 * runPipeline and getCurrentHead are mocked so we can assert call behaviour and
 * force errors without driving the full pipeline. A real on-disk SQLite KG is
 * used so the DB-exists guard and meta reads exercise real code.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// --- Mocks -----------------------------------------------------------------

type RunPipelineArgs = [projectDir: string, opts?: { sourceDirs?: string[]; dbPath?: string }];
const runPipelineMock = vi.fn<(...args: RunPipelineArgs) => Promise<unknown>>(async () => ({}));
vi.mock("@graph/kg-pipeline.ts", () => ({
  runPipeline: (...args: RunPipelineArgs) => runPipelineMock(...args),
}));

const getCurrentHeadMock = vi.fn<(cwd: string) => string | null>();
vi.mock("@features/knowledge-graph/git-intel/git-intel-pipeline.ts", () => ({
  getCurrentHead: (cwd: string) => getCurrentHeadMock(cwd),
}));

import { ensureGraphFresh } from "../ensure-graph-fresh.ts";

// --- Helpers ---------------------------------------------------------------

function makeTempProject(): string {
  return mkdtempSync(path.join(tmpdir(), "ensure-graph-fresh-"));
}

function dbPathFor(projectDir: string): string {
  return path.join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
}

/** Create the .canon dir + a real KG DB, optionally stamping a marker. */
function seedDb(projectDir: string, marker?: string): void {
  mkdirSync(path.join(projectDir, CANON_DIR), { recursive: true });
  const db = initDatabase(dbPathFor(projectDir));
  if (marker !== undefined) {
    const store = new KgStore(db);
    store.setMeta("graph_head_commit", marker);
  }
  db.close();
}

// --- Tests -----------------------------------------------------------------

describe("ensureGraphFresh", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
    runPipelineMock.mockClear();
    getCurrentHeadMock.mockReset();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("refreshes when stored marker !== HEAD", async () => {
    seedDb(projectDir, "old-sha");
    getCurrentHeadMock.mockReturnValue("new-sha");

    await ensureGraphFresh(projectDir);

    expect(runPipelineMock).toHaveBeenCalledTimes(1);
  });

  test("refreshes when marker is absent (graph never stamped)", async () => {
    seedDb(projectDir); // no marker
    getCurrentHeadMock.mockReturnValue("some-sha");

    await ensureGraphFresh(projectDir);

    expect(runPipelineMock).toHaveBeenCalledTimes(1);
  });

  test("no-ops when stored marker === HEAD", async () => {
    seedDb(projectDir, "same-sha");
    getCurrentHeadMock.mockReturnValue("same-sha");

    await ensureGraphFresh(projectDir);

    expect(runPipelineMock).not.toHaveBeenCalled();
  });

  test("no-ops (and does not build) when the DB file does not exist", async () => {
    // No seedDb call → no DB file.
    getCurrentHeadMock.mockReturnValue("some-sha");

    await ensureGraphFresh(projectDir);

    expect(runPipelineMock).not.toHaveBeenCalled();
  });

  test("no-ops when HEAD is null (git unavailable), even with a marker", async () => {
    seedDb(projectDir, "old-sha");
    getCurrentHeadMock.mockReturnValue(null);

    await ensureGraphFresh(projectDir);

    expect(runPipelineMock).not.toHaveBeenCalled();
  });

  test("fail-open: does not throw when getCurrentHead throws", async () => {
    seedDb(projectDir, "old-sha");
    getCurrentHeadMock.mockImplementation(() => {
      throw new Error("git exploded");
    });

    await expect(ensureGraphFresh(projectDir)).resolves.toBeUndefined();
    expect(runPipelineMock).not.toHaveBeenCalled();
  });

  test("fail-open: does not throw when runPipeline rejects", async () => {
    seedDb(projectDir, "old-sha");
    getCurrentHeadMock.mockReturnValue("new-sha");
    runPipelineMock.mockRejectedValueOnce(new Error("pipeline exploded"));

    await expect(ensureGraphFresh(projectDir)).resolves.toBeUndefined();
    expect(runPipelineMock).toHaveBeenCalledTimes(1);
  });

  test("passes sourceDirs through to runPipeline when stale", async () => {
    seedDb(projectDir, "old-sha");
    getCurrentHeadMock.mockReturnValue("new-sha");

    await ensureGraphFresh(projectDir, { sourceDirs: ["src", "lib"] });

    expect(runPipelineMock).toHaveBeenCalledTimes(1);
    const [, opts] = runPipelineMock.mock.calls[0];
    expect(opts?.sourceDirs).toEqual(["src", "lib"]);
  });
});

// Single-flight guard tests — TDD: write tests first

describe("ensureGraphFresh single-flight guard", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
    runPipelineMock.mockClear();
    getCurrentHeadMock.mockReset();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("concurrent stale calls for same DB run pipeline exactly once", async () => {
    seedDb(projectDir, "old-sha");
    getCurrentHeadMock.mockReturnValue("new-sha");

    // Deferred mock: first resolve is manual so both callers can be in-flight simultaneously
    let resolve!: () => void;
    const deferred = new Promise<void>((res) => {
      resolve = res;
    });
    runPipelineMock.mockImplementationOnce(async () => {
      await deferred;
      return {};
    });

    // Fire both concurrently — do not await yet
    const p1 = ensureGraphFresh(projectDir);
    const p2 = ensureGraphFresh(projectDir);

    // Let the deferred complete so both resolve
    resolve();
    await Promise.all([p1, p2]);

    expect(runPipelineMock).toHaveBeenCalledTimes(1);
  });

  test("distinct DBs are not serialized (each gets its own pipeline call)", async () => {
    // Two separate project dirs → two separate dbPaths
    const projectDir2 = makeTempProject();
    try {
      seedDb(projectDir, "old-sha");
      seedDb(projectDir2, "old-sha");
      getCurrentHeadMock.mockReturnValue("new-sha");

      await Promise.all([ensureGraphFresh(projectDir), ensureGraphFresh(projectDir2)]);

      expect(runPipelineMock).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(projectDir2, { force: true, recursive: true });
    }
  });

  test("map cleared after completion so next stale cycle refreshes", async () => {
    seedDb(projectDir, "old-sha");
    getCurrentHeadMock.mockReturnValue("new-sha");

    // First stale pair
    await Promise.all([ensureGraphFresh(projectDir), ensureGraphFresh(projectDir)]);
    expect(runPipelineMock).toHaveBeenCalledTimes(1);

    // Simulate another stale condition (marker still old because mock doesn't actually stamp)
    runPipelineMock.mockClear();
    await ensureGraphFresh(projectDir);
    // Second call should trigger a new pipeline run (entry was cleared in finally)
    expect(runPipelineMock).toHaveBeenCalledTimes(1);
  });

  test("rejecting runPipeline still fails open and clears the entry", async () => {
    seedDb(projectDir, "old-sha");
    getCurrentHeadMock.mockReturnValue("new-sha");
    runPipelineMock.mockRejectedValueOnce(new Error("pipeline exploded"));

    // Should not throw
    await expect(ensureGraphFresh(projectDir)).resolves.toBeUndefined();

    // The map entry should be cleared — a subsequent call retries
    runPipelineMock.mockClear();
    runPipelineMock.mockResolvedValueOnce({});
    await ensureGraphFresh(projectDir);
    expect(runPipelineMock).toHaveBeenCalledTimes(1);
  });
});
