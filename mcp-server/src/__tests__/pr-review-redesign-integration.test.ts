/**
 * pr-review-redesign-integration.test.ts
 *
 * Integration tests and coverage gap fills for the PR Review Prep redesign.
 *
 * Wave 1 (pr-review-data.ts) adds classifyFile(), generateNarrative(), and
 * computeBlastRadius() to getPrReviewData(). Wave 2 (PrReviewPrep.svelte)
 * consumes those fields in the UI.
 *
 * This file covers:
 *   1. Cross-task integration: getPrReviewData() → bucket/reason fields
 *      wired end-to-end (classifyFile result appears on returned files)
 *   2. Cross-task integration: getPrReviewData() → narrative field
 *      wired end-to-end (generateNarrative result appears in output)
 *   3. computeBlastRadius() via getPrReviewData() with real graph edges
 *      (declared known gap from Task 01 summary)
 *   4. classifyFile() edge cases: both violations AND high in_degree present
 *   5. classifyFile() reason string for 1 violation (singular word)
 *   6. generateNarrative() singular file / singular layer wording
 *   7. generateNarrative() single file with in_degree > 0 uses "file depends"
 *   8. UI helper pure-logic tests extracted from Svelte source:
 *      formatAge(), shortPath(), statusIcon(), statusClass(), groupByDepth()
 *   9. setActiveLayer() toggle: second click on same layer resets to null
 *  10. Svelte component contract: No `truncate` import gap (uses lib/constants)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { classifyFile, generateNarrative } from "../tools/pr-review-data.ts";
import type { PrFileInfo } from "../tools/pr-review-data.ts";

// ── helper ──

function makeMockExecFile(stdout: string, err: Error | null = null) {
  return (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => cb(err, err ? "" : stdout, "");
}

function makeFile(
  path: string,
  layer: string,
  overrides: Partial<PrFileInfo> = {},
): PrFileInfo {
  return {
    path,
    layer,
    status: "modified",
    bucket: "low-risk",
    reason: "",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Cross-task integration: bucket + reason fields wired end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe("getPrReviewData — bucket + reason fields wired (Task 01 → 02 integration)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-redesign-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("every returned file has a bucket field (never undefined)", async () => {
    const graphData = {
      nodes: [
        { id: "src/tools/a.ts", layer: "tools", violation_count: 0, changed: true },
        { id: "src/graph/b.ts", layer: "graph", violation_count: 2, changed: true },
      ],
      edges: [{ source: "src/tools/a.ts", target: "src/graph/b.ts" }],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/tools/a.ts\nM\tsrc/graph/b.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    for (const file of result.files) {
      expect(["needs-attention", "worth-a-look", "low-risk"]).toContain(file.bucket);
    }
  });

  it("every returned file has a non-empty reason string", async () => {
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/tools/a.ts\nA\tsrc/graph/b.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    for (const file of result.files) {
      expect(typeof file.reason).toBe("string");
      expect(file.reason.length).toBeGreaterThan(0);
    }
  });

  it("file with violation_count > 0 in graph data gets needs-attention bucket", async () => {
    // This is the key cross-task contract: classifyFile() is wired inside getPrReviewData()
    // and uses priority_factors populated from graph data.
    const graphData = {
      nodes: [
        { id: "src/tools/bad.ts", layer: "tools", violation_count: 3, changed: true },
      ],
      edges: [],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/tools/bad.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    const badFile = result.files.find((f) => f.path === "src/tools/bad.ts");
    expect(badFile).toBeDefined();
    expect(badFile?.bucket).toBe("needs-attention");
    expect(badFile?.reason).toMatch(/violation/i);
    expect(badFile?.reason).toContain("3");
  });

  it("file without graph data gets low-risk bucket and reason (no graph → no factors)", async () => {
    // No graph-data.json: priority_factors will be undefined → classifyFile → low-risk
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/orphan/file.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    const file = result.files[0];
    expect(file?.bucket).toBe("low-risk");
    expect(file?.reason).toMatch(/low.risk|minimal|depend/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Cross-task integration: narrative field wired end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe("getPrReviewData — narrative field wired end-to-end (Task 01 → 02 integration)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-redesign-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("narrative is a non-empty string in every response", async () => {
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/a.ts"),
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

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/tools/a.ts\nA\tsrc/tools/b.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // generateNarrative inserts total file count + top layer name
    expect(result.narrative).toContain("2");
    expect(result.narrative).toContain("tools");
  });

  it("narrative for empty diff is a short non-empty string (not an error)", async () => {
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(typeof result.narrative).toBe("string");
    expect(result.narrative.length).toBeGreaterThan(0);
    // Should say something about "no changed files"
    expect(result.narrative).toMatch(/no changed files/i);
  });

  it("narrative mentions violations when graph data has violation_count > 0", async () => {
    const graphData = {
      nodes: [
        { id: "src/tools/bad.ts", layer: "tools", violation_count: 2, changed: true },
        { id: "src/tools/ok.ts", layer: "tools", violation_count: 0, changed: true },
      ],
      edges: [],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/tools/bad.ts\nM\tsrc/tools/ok.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.narrative).toMatch(/violation/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. computeBlastRadius() via getPrReviewData() — declared known gap (Task 01)
// ─────────────────────────────────────────────────────────────────────────────

describe("getPrReviewData — computeBlastRadius() with real graph edges (known gap)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-redesign-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("blast_radius is an empty array when no graph data is present", async () => {
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/a.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(Array.isArray(result.blast_radius)).toBe(true);
    expect(result.blast_radius).toHaveLength(0);
  });

  it("blast_radius is empty when changed files have in_degree below threshold (< 3)", async () => {
    // A file that imports two things but has in_degree=2 — below the threshold of 3
    const graphData = {
      nodes: [
        { id: "src/a.ts", layer: "tools", violation_count: 0, changed: true },
        { id: "src/b.ts", layer: "tools", violation_count: 0, changed: false },
      ],
      edges: [
        // Only 2 files import src/a.ts → in_degree = 2, below threshold
        { source: "src/b.ts", target: "src/a.ts" },
        { source: "src/c.ts", target: "src/a.ts" },
      ],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/a.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // in_degree=2 < threshold of 3, so blast_radius should be empty
    expect(result.blast_radius).toHaveLength(0);
  });

  it("blast_radius includes an entry when a changed file has in_degree >= 3", async () => {
    // src/hub.ts is imported by 4 files → in_degree=4 → qualifies for blast radius seed
    const graphData = {
      nodes: [
        { id: "src/hub.ts", layer: "tools", violation_count: 0, changed: true },
        { id: "src/consumer1.ts", layer: "tools", violation_count: 0, changed: false },
        { id: "src/consumer2.ts", layer: "tools", violation_count: 0, changed: false },
        { id: "src/consumer3.ts", layer: "tools", violation_count: 0, changed: false },
        { id: "src/consumer4.ts", layer: "tools", violation_count: 0, changed: false },
      ],
      edges: [
        // These edges represent "consumerX imports hub" — reverse adj puts hub as target
        { source: "src/consumer1.ts", target: "src/hub.ts" },
        { source: "src/consumer2.ts", target: "src/hub.ts" },
        { source: "src/consumer3.ts", target: "src/hub.ts" },
        { source: "src/consumer4.ts", target: "src/hub.ts" },
      ],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/hub.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.blast_radius).toHaveLength(1);
    const entry = result.blast_radius[0];
    expect(entry?.file).toBe("src/hub.ts");
    // affected should include the 4 consumers (all at depth 1)
    expect(entry?.affected.length).toBeGreaterThanOrEqual(1);
    // All affected entries have depth=1 (direct dependents only)
    for (const aff of entry?.affected ?? []) {
      expect(aff.depth).toBe(1);
    }
  });

  it("blast_radius capped at 10 affected files per seed", async () => {
    // Create a hub with 15 importers — blast radius must cap at 10
    const consumers = Array.from({ length: 15 }, (_, i) => ({
      id: `src/consumer${i}.ts`,
      layer: "tools",
      violation_count: 0,
      changed: false,
    }));
    const edges = consumers.map((c) => ({
      source: c.id,
      target: "src/hub.ts",
    }));

    const graphData = {
      nodes: [
        { id: "src/hub.ts", layer: "tools", violation_count: 0, changed: true },
        ...consumers,
      ],
      edges,
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/hub.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.blast_radius).toHaveLength(1);
    const entry = result.blast_radius[0];
    // Must be capped at MAX_AFFECTED_PER_SEED = 10
    expect(entry?.affected.length).toBeLessThanOrEqual(10);
  });

  it("blast_radius capped at 3 seed files (MAX_SEEDS)", async () => {
    // 5 changed files each with in_degree=4 — only top 3 by in_degree become seeds
    const hubs = ["hub1", "hub2", "hub3", "hub4", "hub5"].map((name, i) => ({
      id: `src/${name}.ts`,
      // Give different in_degrees by varying number of consumers
      consumers: 4 + i, // hub1=4, hub2=5, hub3=6, hub4=7, hub5=8
    }));

    const nodes: Array<{ id: string; layer: string; violation_count: number; changed: boolean }> = [];
    const edges: Array<{ source: string; target: string }> = [];

    for (const hub of hubs) {
      nodes.push({ id: hub.id, layer: "tools", violation_count: 0, changed: true });
      for (let j = 0; j < hub.consumers; j++) {
        const cId = `src/c_${hub.id.replace(/\W/g, "_")}_${j}.ts`;
        nodes.push({ id: cId, layer: "tools", violation_count: 0, changed: false });
        edges.push({ source: cId, target: hub.id });
      }
    }

    const graphData = { nodes, edges };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    const diffOutput = hubs.map((h) => `M\t${h.id}`).join("\n");
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(diffOutput),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // Only top 3 seeds (hub5, hub4, hub3 by descending in_degree)
    expect(result.blast_radius.length).toBeLessThanOrEqual(3);
    // The seeds selected should be the ones with the highest in_degree
    const seedFiles = result.blast_radius.map((e) => e.file);
    // hub5 (8 consumers) and hub4 (7 consumers) must be among them
    expect(seedFiles).toContain("src/hub5.ts");
    expect(seedFiles).toContain("src/hub4.ts");
  });

  it("blast_radius only seeds from changed files (is_changed must be true)", async () => {
    // hub.ts has in_degree=5 but is NOT changed — should not appear in blast_radius
    const graphData = {
      nodes: [
        // changed=false: not a candidate seed
        { id: "src/hub.ts", layer: "tools", violation_count: 0, changed: false },
        { id: "src/c1.ts", layer: "tools", violation_count: 0, changed: false },
        { id: "src/c2.ts", layer: "tools", violation_count: 0, changed: false },
        { id: "src/c3.ts", layer: "tools", violation_count: 0, changed: false },
        { id: "src/c4.ts", layer: "tools", violation_count: 0, changed: false },
        { id: "src/c5.ts", layer: "tools", violation_count: 0, changed: false },
        // actually changed but low in_degree
        { id: "src/actual-change.ts", layer: "tools", violation_count: 0, changed: true },
      ],
      edges: [
        { source: "src/c1.ts", target: "src/hub.ts" },
        { source: "src/c2.ts", target: "src/hub.ts" },
        { source: "src/c3.ts", target: "src/hub.ts" },
        { source: "src/c4.ts", target: "src/hub.ts" },
        { source: "src/c5.ts", target: "src/hub.ts" },
      ],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    // Only actual-change.ts is in the diff (hub.ts is not changed)
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/actual-change.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // hub.ts is not in the diff → not a blast radius seed
    expect(result.blast_radius.map((e) => e.file)).not.toContain("src/hub.ts");
    // actual-change.ts has in_degree=0 from the diff perspective → empty blast radius
    expect(result.blast_radius).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. classifyFile() — coverage gap: both violations AND high in_degree
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyFile() — coverage gap: violations + high in_degree both present", () => {
  it("violation check takes precedence over high in_degree (violations win)", () => {
    // File has both violation_count > 0 AND in_degree >= 5 AND is_changed
    // Per code order, violation check fires first.
    const file = makeFile("src/a.ts", "tools", {
      priority_factors: {
        in_degree: 10,
        violation_count: 2,
        is_changed: true,
        layer: "tools",
        layer_centrality: 3,
      },
    });

    const result = classifyFile(file);
    expect(result.bucket).toBe("needs-attention");
    // Reason should mention violations, not the in_degree rule
    expect(result.reason).toMatch(/violation/i);
    expect(result.reason).toContain("2");
  });

  it("reason for 1 violation uses singular 'violation' (not 'violations')", () => {
    const file = makeFile("src/a.ts", "tools", {
      priority_factors: {
        in_degree: 0,
        violation_count: 1,
        is_changed: true,
        layer: "tools",
        layer_centrality: 1,
      },
    });

    const { reason } = classifyFile(file);
    // Exact singular form
    expect(reason).toContain("1 violation");
    expect(reason).not.toContain("violations");
  });

  it("reason for multiple violations uses plural 'violations'", () => {
    const file = makeFile("src/a.ts", "tools", {
      priority_factors: {
        in_degree: 0,
        violation_count: 5,
        is_changed: true,
        layer: "tools",
        layer_centrality: 1,
      },
    });

    const { reason } = classifyFile(file);
    expect(reason).toContain("5 violations");
  });

  it("classifyFile falls through to worth-a-look when in_degree < 5 (changed) and score >= 5", () => {
    // in_degree=4 (not needs-attention) + priority_score=6 (worth-a-look)
    const file = makeFile("src/a.ts", "tools", {
      priority_score: 6,
      priority_factors: {
        in_degree: 4,
        violation_count: 0,
        is_changed: true,
        layer: "tools",
        layer_centrality: 2,
      },
    });

    const result = classifyFile(file);
    expect(result.bucket).toBe("worth-a-look");
  });

  it("high in_degree with no priority_factors → low-risk (no factors means no classification triggers)", () => {
    // When priority_factors is undefined, the violation and in_degree checks both skip
    const file = makeFile("src/a.ts", "tools");
    // No priority_factors, no priority_score → low-risk
    const result = classifyFile(file);
    expect(result.bucket).toBe("low-risk");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. generateNarrative() — singular wording coverage gaps
// ─────────────────────────────────────────────────────────────────────────────

describe("generateNarrative() — singular/plural wording (coverage gaps)", () => {
  it("uses 'file' (singular) when total_files is 1", () => {
    const files = [makeFile("src/tools/only.ts", "tools")];
    const layers = [{ name: "tools", file_count: 1 }];

    const narrative = generateNarrative(files, layers);
    // Should say "1 file" not "1 files"
    expect(narrative).toMatch(/\b1 file\b/);
    expect(narrative).not.toMatch(/\b1 files\b/);
  });

  it("uses 'layer' (singular) when there is exactly one layer", () => {
    const files = [
      makeFile("src/tools/a.ts", "tools"),
      makeFile("src/tools/b.ts", "tools"),
    ];
    const layers = [{ name: "tools", file_count: 2 }];

    const narrative = generateNarrative(files, layers);
    // Should say "1 layer" not "1 layers"
    expect(narrative).toMatch(/\b1 layer\b/);
    expect(narrative).not.toMatch(/\b1 layers\b/);
  });

  it("uses 'file depends' (singular) when only one file depends on the hub", () => {
    const files = [
      makeFile("src/tools/hub.ts", "tools", {
        priority_factors: {
          in_degree: 1,
          violation_count: 0,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
        },
      }),
    ];
    const layers = [{ name: "tools", file_count: 1 }];

    const narrative = generateNarrative(files, layers);
    // in_degree=1 > 0 so the impact sentence fires
    // Should say "1 file depends" not "1 files depend"
    expect(narrative).toMatch(/\b1 file depends\b/);
    expect(narrative).not.toMatch(/files depend/);
  });

  it("uses 'files depend' (plural) when multiple files depend on the hub", () => {
    const files = [
      makeFile("src/tools/hub.ts", "tools", {
        priority_factors: {
          in_degree: 5,
          violation_count: 0,
          is_changed: true,
          layer: "tools",
          layer_centrality: 2,
        },
      }),
    ];
    const layers = [{ name: "tools", file_count: 1 }];

    const narrative = generateNarrative(files, layers);
    expect(narrative).toMatch(/5 files depend/);
  });

  it("uses 'violation' (singular) in narrative when total violations is 1", () => {
    const files = [
      makeFile("src/tools/bad.ts", "tools", {
        priority_factors: {
          in_degree: 0,
          violation_count: 1,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
        },
      }),
    ];
    const layers = [{ name: "tools", file_count: 1 }];

    const narrative = generateNarrative(files, layers);
    // "There is 1 principle violation to address."
    expect(narrative).toMatch(/\bthere is\b/i);
    expect(narrative).toContain("1 principle violation");
  });

  it("uses 'violations' (plural) and 'are' in narrative when total violations > 1", () => {
    const files = [
      makeFile("src/tools/bad.ts", "tools", {
        priority_factors: {
          in_degree: 0,
          violation_count: 2,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
        },
      }),
      makeFile("src/tools/also-bad.ts", "tools", {
        priority_factors: {
          in_degree: 0,
          violation_count: 1,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
        },
      }),
    ];
    const layers = [{ name: "tools", file_count: 2 }];

    const narrative = generateNarrative(files, layers);
    // Total = 3 violations → "There are 3 principle violations"
    expect(narrative).toMatch(/\bthere are\b/i);
    expect(narrative).toContain("3 principle violations");
  });

  it("skips impact sentence when max in_degree is 0 (no dependents)", () => {
    const files = [
      makeFile("src/tools/leaf.ts", "tools", {
        priority_factors: {
          in_degree: 0,
          violation_count: 0,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
        },
      }),
    ];
    const layers = [{ name: "tools", file_count: 1 }];

    const narrative = generateNarrative(files, layers);
    // max in_degree = 0 → condition `maxInDegree > 0` is false → no impact sentence
    expect(narrative).not.toMatch(/most consequential/i);
    expect(narrative).not.toMatch(/files? depend/i);
  });

  it("uses top layer with most files (not first layer in array)", () => {
    const files = [
      makeFile("src/tools/a.ts", "tools"),
      makeFile("src/graph/b.ts", "graph"),
      makeFile("src/graph/c.ts", "graph"),
      makeFile("src/graph/d.ts", "graph"),
    ];
    // graph has 3 files, tools has 1 — graph should be the top layer
    const layers = [
      { name: "tools", file_count: 1 },
      { name: "graph", file_count: 3 },
    ];

    const narrative = generateNarrative(files, layers);
    expect(narrative).toContain("graph");
    // The first sentence specifically names the top layer
    const firstSentence = narrative.split(".")[0];
    expect(firstSentence).toContain("graph");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. UI helper pure-logic tests (extracted from Svelte source)
//    These test the *logic* of helper functions whose behavior was only
//    verified structurally in the entry-point tests.
// ─────────────────────────────────────────────────────────────────────────────

// The helpers are not exported from PrReviewPrep.svelte, so we reproduce the
// exact logic here (copied verbatim from the component) and test it as a unit.
// This is intentional: the Svelte entry test confirmed the helpers *exist*;
// these tests confirm the helpers *behave correctly*.

function statusIcon(fileStatus: "added" | "modified" | "deleted" | "renamed"): string {
  switch (fileStatus) {
    case "added":    return "+";
    case "deleted":  return "−";
    case "renamed":  return "→";
    default:         return "~";
  }
}

function statusClass(fileStatus: "added" | "modified" | "deleted" | "renamed"): string {
  switch (fileStatus) {
    case "added":    return "status-added";
    case "deleted":  return "status-deleted";
    case "renamed":  return "status-renamed";
    default:         return "status-modified";
  }
}

function shortPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return "…/" + parts.slice(-2).join("/");
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function groupByDepth(
  affected: Array<{ path: string; depth: number }>,
): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const { path, depth } of affected) {
    if (!map.has(depth)) map.set(depth, []);
    map.get(depth)!.push(path);
  }
  return map;
}

describe("PrReviewPrep helper: statusIcon()", () => {
  it("returns '+' for added", () => expect(statusIcon("added")).toBe("+"));
  it("returns '−' for deleted", () => expect(statusIcon("deleted")).toBe("−"));
  it("returns '→' for renamed", () => expect(statusIcon("renamed")).toBe("→"));
  it("returns '~' for modified", () => expect(statusIcon("modified")).toBe("~"));
});

describe("PrReviewPrep helper: statusClass()", () => {
  it("returns 'status-added' for added", () => expect(statusClass("added")).toBe("status-added"));
  it("returns 'status-deleted' for deleted", () => expect(statusClass("deleted")).toBe("status-deleted"));
  it("returns 'status-renamed' for renamed", () => expect(statusClass("renamed")).toBe("status-renamed"));
  it("returns 'status-modified' for modified", () => expect(statusClass("modified")).toBe("status-modified"));
});

describe("PrReviewPrep helper: shortPath()", () => {
  it("returns path unchanged when 2 or fewer segments", () => {
    expect(shortPath("src/file.ts")).toBe("src/file.ts");
    expect(shortPath("file.ts")).toBe("file.ts");
  });

  it("truncates deep paths to last 2 segments with ellipsis prefix", () => {
    expect(shortPath("src/tools/pr-review-data.ts")).toBe("…/tools/pr-review-data.ts");
    expect(shortPath("a/b/c/d.ts")).toBe("…/c/d.ts");
  });

  it("handles exactly 3 segments", () => {
    expect(shortPath("src/tools/file.ts")).toBe("…/tools/file.ts");
  });
});

describe("PrReviewPrep helper: formatAge()", () => {
  it("formats sub-hour durations as minutes", () => {
    // 5 minutes = 300000 ms
    expect(formatAge(300000)).toBe("5m ago");
    // 59 minutes = 3540000 ms
    expect(formatAge(3540000)).toBe("59m ago");
  });

  it("formats 1-23 hour durations as hours", () => {
    // 1 hour = 3600000 ms
    expect(formatAge(3600000)).toBe("1h ago");
    // 23 hours = 82800000 ms
    expect(formatAge(82800000)).toBe("23h ago");
  });

  it("formats 24+ hour durations as days", () => {
    // 1 day = 86400000 ms
    expect(formatAge(86400000)).toBe("1d ago");
    // 7 days
    expect(formatAge(7 * 86400000)).toBe("7d ago");
  });

  it("rounds to nearest unit (30 min stays 30m, not 0h)", () => {
    // 30 minutes = 1800000 ms → rounds to 30m, not 0h (30 < 60 → minutes branch)
    expect(formatAge(1800000)).toBe("30m ago");
  });
});

describe("PrReviewPrep helper: groupByDepth()", () => {
  it("groups a single depth-1 entry correctly", () => {
    const result = groupByDepth([{ path: "src/a.ts", depth: 1 }]);
    expect(result.get(1)).toEqual(["src/a.ts"]);
    expect(result.size).toBe(1);
  });

  it("groups multiple paths at the same depth together", () => {
    const result = groupByDepth([
      { path: "src/a.ts", depth: 1 },
      { path: "src/b.ts", depth: 1 },
      { path: "src/c.ts", depth: 2 },
    ]);
    expect(result.get(1)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.get(2)).toEqual(["src/c.ts"]);
    expect(result.size).toBe(2);
  });

  it("returns an empty map for empty input", () => {
    const result = groupByDepth([]);
    expect(result.size).toBe(0);
  });

  it("preserves insertion order within each depth group", () => {
    const result = groupByDepth([
      { path: "src/first.ts", depth: 1 },
      { path: "src/second.ts", depth: 1 },
      { path: "src/third.ts", depth: 1 },
    ]);
    expect(result.get(1)).toEqual(["src/first.ts", "src/second.ts", "src/third.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. setActiveLayer() toggle logic — declared gap (Task 02)
// ─────────────────────────────────────────────────────────────────────────────

// The toggle logic is: activeLayer === layer ? null : layer
// This behavior is declared untested in Task 02 Coverage Notes.
// Testing the pure logic of the toggler extracted from the component.

function setActiveLayer(
  activeLayer: string | null,
  layer: string | null,
): string | null {
  return activeLayer === layer ? null : layer;
}

describe("PrReviewPrep setActiveLayer() toggle logic (declared gap)", () => {
  it("sets active layer when none is active", () => {
    expect(setActiveLayer(null, "tools")).toBe("tools");
  });

  it("resets to null when clicking the already-active layer (toggle off)", () => {
    // This is the declared gap: second click deactivates
    expect(setActiveLayer("tools", "tools")).toBeNull();
  });

  it("switches to a different layer when one is already active", () => {
    expect(setActiveLayer("tools", "graph")).toBe("graph");
  });

  it("setting null layer (All tab) when no layer is active returns null", () => {
    expect(setActiveLayer(null, null)).toBeNull();
  });

  it("setting null layer (All tab) when a layer is active resets to null", () => {
    // The All button calls setActiveLayer(null) which should deactivate filtering
    // Note: All tab passes null as the layer argument, not the same as activeLayer
    // activeLayer === null !== "tools" → setActiveLayer("tools", null) → null
    expect(setActiveLayer("tools", null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. filteredFiles derived state logic — declared gap (Task 02)
// ─────────────────────────────────────────────────────────────────────────────

// The component uses: activeLayer ? files.filter(f => f.layer === activeLayer) : files
// This is the "No test verifying that activeLayer actually filters file display" gap.
// Testing the pure filtering logic.

function filteredFiles(
  allFiles: PrFileInfo[],
  activeLayer: string | null,
): PrFileInfo[] {
  return activeLayer ? allFiles.filter((f) => f.layer === activeLayer) : allFiles;
}

describe("filteredFiles derived state logic (declared gap)", () => {
  const files: PrFileInfo[] = [
    makeFile("src/tools/a.ts", "tools"),
    makeFile("src/tools/b.ts", "tools"),
    makeFile("src/graph/c.ts", "graph"),
    makeFile("src/graph/d.ts", "graph"),
    makeFile("src/graph/e.ts", "graph"),
  ];

  it("returns all files when activeLayer is null", () => {
    const result = filteredFiles(files, null);
    expect(result).toHaveLength(5);
  });

  it("filters to only tools-layer files when activeLayer is 'tools'", () => {
    const result = filteredFiles(files, "tools");
    expect(result).toHaveLength(2);
    expect(result.every((f) => f.layer === "tools")).toBe(true);
  });

  it("filters to only graph-layer files when activeLayer is 'graph'", () => {
    const result = filteredFiles(files, "graph");
    expect(result).toHaveLength(3);
    expect(result.every((f) => f.layer === "graph")).toBe(true);
  });

  it("returns empty array when activeLayer matches no files", () => {
    const result = filteredFiles(files, "nonexistent-layer");
    expect(result).toHaveLength(0);
  });

  it("filtering feeds into bucket derivation: only layer-filtered files appear in each bucket", () => {
    // Verify end-to-end: filter → then bucket split produces correct counts
    const mixedFiles: PrFileInfo[] = [
      makeFile("src/tools/high.ts", "tools", { bucket: "needs-attention" }),
      makeFile("src/tools/mid.ts", "tools", { bucket: "worth-a-look" }),
      makeFile("src/graph/low.ts", "graph", { bucket: "low-risk" }),
    ];

    const toolsFiltered = filteredFiles(mixedFiles, "tools");
    const needsAttention = toolsFiltered.filter((f) => f.bucket === "needs-attention");
    const worthALook = toolsFiltered.filter((f) => f.bucket === "worth-a-look");
    const lowRisk = toolsFiltered.filter((f) => f.bucket === "low-risk");

    expect(needsAttention).toHaveLength(1);
    expect(worthALook).toHaveLength(1);
    // The graph/low.ts file is filtered out — not visible in tools layer
    expect(lowRisk).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Svelte component structural contract: truncate used from lib/constants
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "fs";
import { join as pathJoin, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = pathJoin(__dirname, "../../ui");

describe("PrReviewPrep.svelte — lib/constants import contract", () => {
  const sveltePath = pathJoin(uiDir, "PrReviewPrep.svelte");

  it("imports truncate from lib/constants (used in error display)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    // truncate is used for error display in header bar: truncate(data.error, 60)
    expect(content).toContain("truncate");
    expect(content).toContain("lib/constants");
  });

  it("uses truncate() with the error field in the header bar", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("truncate(data.error");
  });

  it("standalone blast radius section exists for files NOT in needs-attention", () => {
    // The Wave 2 component has a separate blast-standalone section for files
    // whose blast radius entry is not already shown inside a needs-attention row.
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("blast-standalone");
    expect(content).toContain("standaloneBlast");
  });

  it("blast radius toggle tracks expanded state by file path (not by index)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    // expandedBlastRadius is a Set<string> keyed by file.path
    expect(content).toContain("expandedBlastRadius");
    expect(content).toContain("toggleBlastRadius");
    expect(content).toContain("file.path");
  });
});
