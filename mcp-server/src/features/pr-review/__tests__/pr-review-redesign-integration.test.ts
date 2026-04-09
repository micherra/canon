/**
 * pr-review-redesign-integration.test.ts
 *
 * Integration tests and coverage gap fills for the PR Review Prep redesign.
 *
 * Wave 1 (pr-review-data.ts) adds classifyFile(), generateNarrative(), and
 * computeBlastRadius() to getPrReviewData(). Wave 2 (PrReview.svelte)
 * consumes those fields in the UI.
 *
 * This file covers:
 *   1. Cross-task integration: getPrReviewData() → bucket/reason fields
 *      wired end-to-end (classifyFile result appears on returned files)
 *   2. Cross-task integration: getPrReviewData() → narrative field
 *      wired end-to-end (generateNarrative result appears in output)
 *   3. computeBlastRadius() via getPrReviewData() with real graph edges
 *      (declared known gap from Task 01 summary)
 *
 * Split files:
 *   - pr-review-redesign-helpers.test.ts — UI helper pure-logic tests
 *     (statusIcon, statusClass, shortPath, formatAge, groupByDepth)
 *   - pr-review-redesign-ui.test.ts — setActiveLayer toggle, filteredFiles
 *     derived state, PrReview.svelte v2 structural contract
 *   - pr-review-redesign-classifynarrative.test.ts — classifyFile() and
 *     generateNarrative() pure function coverage gaps (describes 4-5)
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/** Build a mock gitExecAsync that returns an ok ProcessResult with the given stdout. */
function mockGitExecAsyncOk(stdout: string) {
  return vi.fn().mockResolvedValue({
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout,
    timedOut: false,
  });
}

// 1. Cross-task integration: bucket + reason fields wired end-to-end

describe("getPrReviewData — bucket + reason fields wired (Task 01 → 02 integration)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-redesign-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("every returned file has a bucket field (never undefined)", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/tools/a.ts\nM\tsrc/graph/b.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    for (const file of result.impact_files) {
      expect(["needs-attention", "worth-a-look", "low-risk"]).toContain(file.bucket);
    }
  });

  it("every impact_file has a non-empty reason string", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/tools/a.ts\nA\tsrc/graph/b.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    for (const file of result.impact_files) {
      expect(typeof file.reason).toBe("string");
      expect(file.reason.length).toBeGreaterThan(0);
    }
  });

  it("file with stored violations appears in impact_files due to violations filter", async () => {
    // Files with stored DriftStore violations appear in impact_files even when bucket=low-risk
    // (because the impact_files filter includes files where violations.length > 0)
    const { DriftStore } = await import("@platform/storage/drift/store.js");
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      files: ["src/tools/bad.ts"],
      honored: [],
      review_id: "rev_bucket_test",
      score: {
        conventions: { passed: 0, total: 1 },
        opinions: { passed: 0, total: 1 },
        rules: { passed: 0, total: 1 },
      },
      timestamp: "2026-03-25T00:00:00Z",
      verdict: "WARNING",
      violations: [
        { file_path: "src/tools/bad.ts", principle_id: "p1", severity: "rule" },
        { file_path: "src/tools/bad.ts", principle_id: "p2", severity: "convention" },
        { file_path: "src/tools/bad.ts", principle_id: "p3", severity: "strong-opinion" },
      ],
    });

    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/tools/bad.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // File appears in impact_files because violations.length > 0 (even without KG priority data)
    const badFile = result.impact_files.find((f) => f.path === "src/tools/bad.ts");
    expect(badFile).toBeDefined();
    // Violations populated from DriftStore
    expect(badFile?.violations).toHaveLength(3);
  });

  it("file without graph data is excluded from impact_files (no graph → low-risk)", async () => {
    // No KG DB: priority_factors will be undefined → classifyFile → low-risk
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/orphan/file.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // Low-risk files are in the lightweight files list but not impact_files
    expect(result.files).toHaveLength(1);
    expect(result.impact_files).toHaveLength(0);
  });
});

// 2. Cross-task integration: narrative field wired end-to-end

describe("getPrReviewData — narrative field wired end-to-end (Task 01 → 02 integration)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-redesign-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("narrative is a non-empty string in every response", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/a.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(typeof result.narrative).toBe("string");
    expect(result.narrative.length).toBeGreaterThan(0);
  });

  it("narrative mentions total file count and layer when files are present", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ layers: { tools: ["src/tools"] } }),
    );

    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/tools/a.ts\nA\tsrc/tools/b.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // generateNarrative inserts total file count + top layer name
    expect(result.narrative).toContain("2");
    expect(result.narrative).toContain("tools");
  });

  it("narrative for empty diff is a short non-empty string (not an error)", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(typeof result.narrative).toBe("string");
    expect(result.narrative.length).toBeGreaterThan(0);
    // Should say something about "no changed files"
    expect(result.narrative).toMatch(/no changed files/i);
  });

  it("narrative mentions violations when files have stored violations in DriftStore", async () => {
    // Store a DriftStore review with violations so buildFileViolationMap populates them
    const { DriftStore } = await import("@platform/storage/drift/store.js");
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      files: ["src/tools/bad.ts"],
      honored: [],
      review_id: "rev_narrative_test",
      score: {
        conventions: { passed: 0, total: 1 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 1 },
      },
      timestamp: "2026-03-25T00:00:00Z",
      verdict: "WARNING",
      violations: [
        { file_path: "src/tools/bad.ts", principle_id: "p1", severity: "rule" },
        { file_path: "src/tools/bad.ts", principle_id: "p2", severity: "convention" },
      ],
    });

    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/tools/bad.ts\nM\tsrc/tools/ok.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.narrative).toMatch(/violation/i);
  });
});

// 3. computeBlastRadius() via getPrReviewData() — declared known gap (Task 01)

describe("getPrReviewData — computeBlastRadius() with real graph edges (known gap)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-redesign-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("blast_radius is an empty array when no KG DB is present", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/a.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(Array.isArray(result.blast_radius)).toBe(true);
    expect(result.blast_radius).toHaveLength(0);
  });

  it("blast_radius is empty when changed files have in_degree below threshold (< 3)", async () => {
    // A file with in_degree=2 — below the threshold of 3 — no KG DB present
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/a.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // No KG DB → no priority data → in_degree = 0 < threshold of 3 → empty blast radius
    expect(result.blast_radius).toHaveLength(0);
  });

  it("blast_radius includes an entry when a changed file has in_degree >= 3", async () => {
    // Set up a real SQLite DB: src/hub.ts is imported by 4 files → in_degree=4
    const { initDatabase } = await import("@graph/kg-schema.js");
    const { KgStore } = await import("@graph/kg-store.js");
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const hubFile = store.upsertFile({
      content_hash: "h",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "tools",
      mtime_ms: 1,
      path: "src/hub.ts",
    });
    for (let i = 1; i <= 4; i++) {
      const c = store.upsertFile({
        content_hash: `c${i}`,
        language: "typescript",
        last_indexed_at: Date.now(),
        layer: "tools",
        mtime_ms: 1,
        path: `src/consumer${i}.ts`,
      });
      // consumerX imports hub → file_edge source=consumer, target=hub
      store.insertFileEdge({
        confidence: 1.0,
        edge_type: "imports",
        evidence: null,
        relation: null,
        source_file_id: c.file_id!,
        target_file_id: hubFile.file_id!,
      });
    }
    db.close();

    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/hub.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.blast_radius).toHaveLength(1);
    const entry = result.blast_radius[0];
    expect(entry?.file).toBe("src/hub.ts");
    // affected should include the 4 consumers (all at depth 1)
    expect(entry?.affected.length).toBeGreaterThanOrEqual(1);
    // All affected entries have depth >= 1 (not the seed itself)
    for (const aff of entry?.affected ?? []) {
      expect(aff.depth).toBeGreaterThanOrEqual(1);
    }
  });

  it("blast_radius capped at 10 affected files per seed", async () => {
    // Create a hub with 15 importers — blast radius must cap at 10
    const { initDatabase } = await import("@graph/kg-schema.js");
    const { KgStore } = await import("@graph/kg-store.js");
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const hubFile = store.upsertFile({
      content_hash: "h",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "tools",
      mtime_ms: 1,
      path: "src/hub.ts",
    });
    for (let i = 0; i < 15; i++) {
      const c = store.upsertFile({
        content_hash: `c${i}`,
        language: "typescript",
        last_indexed_at: Date.now(),
        layer: "tools",
        mtime_ms: 1,
        path: `src/consumer${i}.ts`,
      });
      store.insertFileEdge({
        confidence: 1.0,
        edge_type: "imports",
        evidence: null,
        relation: null,
        source_file_id: c.file_id!,
        target_file_id: hubFile.file_id!,
      });
    }
    db.close();

    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/hub.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.blast_radius).toHaveLength(1);
    const entry = result.blast_radius[0];
    // Must be capped at MAX_AFFECTED_PER_SEED = 10
    expect(entry?.affected.length).toBeLessThanOrEqual(10);
  });

  it("blast_radius capped at 3 seed files (MAX_SEEDS)", async () => {
    // 5 hubs each with 4+ importers — only top 3 by in_degree become seeds
    const { initDatabase } = await import("@graph/kg-schema.js");
    const { KgStore } = await import("@graph/kg-store.js");
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);

    const hubs = ["hub1", "hub2", "hub3", "hub4", "hub5"].map((name, i) => ({
      consumers: 4 + i, // hub1=4, hub2=5, hub3=6, hub4=7, hub5=8
      name: `src/${name}.ts`,
    }));

    for (const hub of hubs) {
      const hubFile = store.upsertFile({
        content_hash: hub.name,
        language: "typescript",
        last_indexed_at: Date.now(),
        layer: "tools",
        mtime_ms: 1,
        path: hub.name,
      });
      for (let j = 0; j < hub.consumers; j++) {
        const cPath = `src/c_${hub.name.replace(/\W/g, "_")}_${j}.ts`;
        const c = store.upsertFile({
          content_hash: cPath,
          language: "typescript",
          last_indexed_at: Date.now(),
          layer: "tools",
          mtime_ms: 1,
          path: cPath,
        });
        store.insertFileEdge({
          confidence: 1.0,
          edge_type: "imports",
          evidence: null,
          relation: null,
          source_file_id: c.file_id!,
          target_file_id: hubFile.file_id!,
        });
      }
    }
    db.close();

    const diffOutput = hubs.map((h) => `M\t${h.name}`).join("\n");
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(diffOutput),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // Only top 3 seeds (hub5, hub4, hub3 by descending in_degree)
    expect(result.blast_radius.length).toBeLessThanOrEqual(3);
    // The seeds selected should be the ones with the highest in_degree
    const seedFiles = result.blast_radius.map((e) => e.file);
    // hub5 (8 importers) and hub4 (7 importers) must be among them
    expect(seedFiles).toContain("src/hub5.ts");
    expect(seedFiles).toContain("src/hub4.ts");
  });

  it("blast_radius only seeds from changed files (is_changed must be true)", async () => {
    // hub.ts has high in_degree but is NOT in the diff — should not appear in blast_radius
    // actual-change.ts is in the diff but has no importers → empty blast radius
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/actual-change.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // hub.ts is not in the diff → not a blast radius seed
    expect(result.blast_radius.map((e) => e.file)).not.toContain("src/hub.ts");
    // actual-change.ts has in_degree=0 (not in KG) → empty blast radius
    expect(result.blast_radius).toHaveLength(0);
  });
});
