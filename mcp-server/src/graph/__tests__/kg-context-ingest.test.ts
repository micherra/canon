/**
 * kg-context-ingest.test.ts
 *
 * Tests for ingestContextGraph: derives decision/adr/build nodes and all
 * four typed edge kinds from a fixture decisions array + ADR files, then
 * persists via ContextGraphStore.replaceAll.
 *
 * NOTE (deviation from the m2-02 task plan, discovered during implementation):
 * the plan's `ingestContextGraph(db, projectDir, pluginDir)` would call
 * `buildDecisionsCorpus(projectDir)` internally — but `buildDecisionsCorpus`
 * lives in `@features/orchestration/services/decisions-corpus.ts`, and
 * `.dependency-cruiser.cjs`'s `no-graph-to-orchestration` rule forbids any
 * `src/graph/**` module from importing `src/features/orchestration/**`
 * (verified: `depcruise --validate .dependency-cruiser.cjs src/` fails on
 * this edge). So `ingestContextGraph` takes the already-computed decisions
 * array as a parameter instead — the composition-root caller
 * (`app/register-knowledge.ts`, which already imports `buildDecisionsCorpus`
 * via `recall-handler.ts`'s sibling pattern) resolves the corpus and passes
 * it in. This also lets `ingestContextGraph` be synchronous (no async work
 * remains once the corpus fetch moves out) and makes this test fixture-free
 * for the decisions side.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IngestableDecision, ingestContextGraph } from "@graph/kg-context-ingest.ts";
import { ContextGraphStore } from "@graph/kg-context-store.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let projectDir: string;
let pluginDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "kg-context-ingest-project-"));
  pluginDir = mkdtempSync(join(tmpdir(), "kg-context-ingest-plugin-"));
});

afterEach(() => {
  rmSync(projectDir, { force: true, recursive: true });
  rmSync(pluginDir, { force: true, recursive: true });
});

function writeAdr(filename: string, frontmatter: Record<string, string>, body: string): void {
  mkdirSync(join(pluginDir, "docs", "adr"), { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  writeFileSync(join(pluginDir, "docs", "adr", filename), `---\n${fm}\n---\n\n${body}\n`);
}

function writePrinciple(id: string): void {
  const dir = join(pluginDir, "principles", "conventions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---\nid: ${id}\ntitle: "Test principle"\nseverity: convention\nportable: true\nscope:\n  layers: []\n  file_patterns: []\ntags: []\n---\n\nBody.\n`,
  );
}

function seedFile(db: ReturnType<typeof initDatabase>, path: string): void {
  db.prepare(
    `INSERT INTO files (path, mtime_ms, content_hash, language, last_indexed_at)
     VALUES (?, 0, 'hash', 'ts', '2026-01-01T00:00:00Z')`,
  ).run(path);
}

function makeDecision(overrides: Partial<IngestableDecision> = {}): IngestableDecision {
  return {
    decided_at: "2026-01-01T00:00:00Z",
    decision_type: "plan_approval",
    source_event_id: 1,
    source_slug: "build-a",
    summary: "Approved the plan",
    ...overrides,
  };
}

describe("ingestContextGraph", () => {
  test("derives decision, adr, and build nodes with all four edge kinds", () => {
    const db = initDatabase(":memory:");
    seedFile(db, "src/foo.ts");
    writePrinciple("my-test-principle");
    writeAdr(
      "0001-first-adr.md",
      { adr: "0001", build: "build-a", status: "accepted", title: "First ADR" },
      "Body citing my-test-principle and touching `src/foo.ts` directly.",
    );
    writeAdr(
      "0002-second-adr.md",
      {
        adr: "0002",
        build: "build-b",
        status: "accepted",
        supersedes: "0001",
        title: "Second ADR",
      },
      "Supersedes the first ADR.",
    );

    const decisions: IngestableDecision[] = [
      makeDecision({ refs: ["src/foo.ts"], source_event_id: 1, source_slug: "build-a" }),
    ];

    const result = ingestContextGraph(db, decisions, projectDir, pluginDir);

    expect(result.node_count).toBeGreaterThan(0);
    expect(result.edge_count).toBeGreaterThan(0);

    const store = new ContextGraphStore(db);
    const nodes = store.getAllNodes();
    const edges = store.getAllEdges();

    const nodeIds = nodes.map((n) => n.node_id);
    expect(nodeIds).toContain("decision:build-a#1");
    expect(nodeIds).toContain("adr:ADR-0001");
    expect(nodeIds).toContain("adr:ADR-0002");
    expect(nodeIds).toContain("build:build-a");
    expect(nodeIds).toContain("build:build-b");

    const byType = (t: string) => edges.filter((e) => e.edge_type === t);
    expect(byType("decision_touches_file").length).toBeGreaterThan(0);
    expect(byType("decision_cites_principle").length).toBeGreaterThan(0);
    expect(byType("supersedes")).toEqual([
      {
        dst: "adr:ADR-0001",
        edge_type: "supersedes",
        evidence: expect.any(String),
        src: "adr:ADR-0002",
      },
    ]);
    expect(byType("build_produced").length).toBeGreaterThan(0);

    db.close();
  });

  test("rebuild twice on unchanged inputs yields identical node/edge counts (idempotency, AC6)", () => {
    const db = initDatabase(":memory:");
    seedFile(db, "src/foo.ts");
    writeAdr("0001-first-adr.md", { adr: "0001", status: "accepted", title: "First ADR" }, "Body.");
    const decisions: IngestableDecision[] = [makeDecision({ refs: ["src/foo.ts"] })];

    const first = ingestContextGraph(db, decisions, projectDir, pluginDir);
    const store = new ContextGraphStore(db);
    const nodesAfterFirst = store.getAllNodes().length;
    const edgesAfterFirst = store.getAllEdges().length;

    const second = ingestContextGraph(db, decisions, projectDir, pluginDir);
    const nodesAfterSecond = store.getAllNodes().length;
    const edgesAfterSecond = store.getAllEdges().length;

    expect(second.node_count).toBe(first.node_count);
    expect(second.edge_count).toBe(first.edge_count);
    expect(nodesAfterSecond).toBe(nodesAfterFirst);
    expect(edgesAfterSecond).toBe(edgesAfterFirst);

    db.close();
  });

  test("fail-open: missing ADR directory does not throw, decisions still ingested", () => {
    const db = initDatabase(":memory:");
    seedFile(db, "src/foo.ts");
    const decisions: IngestableDecision[] = [makeDecision({ refs: ["src/foo.ts"] })];

    // pluginDir has no docs/adr — must not throw
    expect(() => ingestContextGraph(db, decisions, projectDir, pluginDir)).not.toThrow();

    const store = new ContextGraphStore(db);
    const nodeIds = store.getAllNodes().map((n) => n.node_id);
    expect(nodeIds).toContain("decision:build-a#1");

    db.close();
  });

  test("empty decisions and no ADRs yields zero nodes/edges without throwing", () => {
    const db = initDatabase(":memory:");
    const result = ingestContextGraph(db, [], projectDir, pluginDir);
    expect(result.node_count).toBe(0);
    expect(result.edge_count).toBe(0);
    db.close();
  });

  test("duplicate ref in a single decision's refs list dedupes to one decision_touches_file edge (review fix)", () => {
    // context_edges has a composite PK (src, dst, edge_type) — deriving the
    // same edge twice from one decision's refs must not throw a UNIQUE
    // violation on the bulk reinsert.
    const db = initDatabase(":memory:");
    seedFile(db, "src/foo.ts");
    const decisions: IngestableDecision[] = [makeDecision({ refs: ["src/foo.ts", "src/foo.ts"] })];

    expect(() => ingestContextGraph(db, decisions, projectDir, pluginDir)).not.toThrow();

    const store = new ContextGraphStore(db);
    const touchesFileEdges = store
      .getAllEdges()
      .filter((e) => e.edge_type === "decision_touches_file");
    expect(touchesFileEdges.length).toBe(1);
    expect(touchesFileEdges[0]).toEqual({
      dst: "src/foo.ts",
      edge_type: "decision_touches_file",
      evidence: "refs",
      src: "decision:build-a#1",
    });

    db.close();
  });

  test("duplicate backtick path cited twice in one ADR body dedupes to one edge (review fix)", () => {
    const db = initDatabase(":memory:");
    seedFile(db, "src/foo.ts");
    writeAdr(
      "0001-first-adr.md",
      { adr: "0001", status: "accepted", title: "First ADR" },
      "Touches `src/foo.ts` here and again touches `src/foo.ts` later in the doc.",
    );

    expect(() => ingestContextGraph(db, [], projectDir, pluginDir)).not.toThrow();

    const store = new ContextGraphStore(db);
    const touchesFileEdges = store
      .getAllEdges()
      .filter((e) => e.edge_type === "decision_touches_file");
    expect(touchesFileEdges.length).toBe(1);

    db.close();
  });

  test("duplicate decision node_id across two corpus entries dedupes to one node (review fix)", () => {
    // A data-quality duplicate upstream (same source_slug#source_event_id
    // appearing twice) must not throw a UNIQUE violation on context_nodes.
    const db = initDatabase(":memory:");
    const decisions: IngestableDecision[] = [
      makeDecision({ summary: "First copy" }),
      makeDecision({ summary: "Second copy" }),
    ];

    expect(() => ingestContextGraph(db, decisions, projectDir, pluginDir)).not.toThrow();

    const store = new ContextGraphStore(db);
    const nodes = store.getAllNodes().filter((n) => n.node_id === "decision:build-a#1");
    expect(nodes.length).toBe(1);

    db.close();
  });
});
