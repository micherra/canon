/**
 * kg-context-store.test.ts
 *
 * Tests for schema v7 (context_nodes, context_edges) and ContextGraphStore:
 * fresh-DB shape, v6→v7 migration preserving existing rows, replaceAll
 * idempotency, and the two read helpers (getNodesForFile, getSupersedesChain).
 */

import { ContextGraphStore } from "@graph/kg-context-store.ts";
import { initDatabase, runMigrations } from "@graph/kg-schema.ts";
import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

function indexExists(db: Database.Database, indexName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName) as { name: string } | undefined;
  return row !== undefined;
}

describe("schema v7 — context_nodes, context_edges", () => {
  test("fresh DB reports schema_version '7' with both context tables", () => {
    const db = initDatabase(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("7");
    expect(tableExists(db, "context_nodes")).toBe(true);
    expect(tableExists(db, "context_edges")).toBe(true);
    expect(indexExists(db, "idx_context_nodes_kind")).toBe(true);
    expect(indexExists(db, "idx_context_edges_src")).toBe(true);
    expect(indexExists(db, "idx_context_edges_dst")).toBe(true);
    db.close();
  });

  test("seeded v6 DB migrates to v7 with a pre-existing files row intact", () => {
    const db = initDatabase(":memory:");
    // Simulate a v6 DB by dropping v7 tables and resetting version
    db.exec(`DROP TABLE IF EXISTS context_edges`);
    db.exec(`DROP TABLE IF EXISTS context_nodes`);
    db.exec(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`);

    // Pre-existing row that must survive the migration untouched
    db.prepare(
      `INSERT INTO files (path, mtime_ms, content_hash, language, last_indexed_at)
       VALUES ('src/foo.ts', 123.0, 'hash1', 'ts', '2026-01-01T00:00:00Z')`,
    ).run();

    expect(tableExists(db, "context_nodes")).toBe(false);
    expect(tableExists(db, "context_edges")).toBe(false);

    runMigrations(db);

    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("7");
    expect(tableExists(db, "context_nodes")).toBe(true);
    expect(tableExists(db, "context_edges")).toBe(true);

    const fileRow = db.prepare(`SELECT path FROM files WHERE path = 'src/foo.ts'`).get() as
      | { path: string }
      | undefined;
    expect(fileRow?.path).toBe("src/foo.ts");
    db.close();
  });

  test("migration v7 is idempotent — running runMigrations again does not fail", () => {
    const db = initDatabase(":memory:");
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });
});

describe("ContextGraphStore", () => {
  function makeDb() {
    return initDatabase(":memory:");
  }

  test("replaceAll twice with identical input yields identical node/edge counts (idempotency, AC6)", () => {
    const db = makeDb();
    const store = new ContextGraphStore(db);
    const nodes = [
      {
        adr_number: null,
        body_excerpt: "first decision",
        node_id: "decision:build-a#1",
        record_kind: "decision" as const,
        ref_slug: "build-a",
        source_event_id: 1,
        status: null,
        title: "First decision",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        adr_number: "0001",
        body_excerpt: "an adr",
        node_id: "adr:ADR-0001",
        record_kind: "adr" as const,
        ref_slug: null,
        source_event_id: null,
        status: "accepted",
        title: "An ADR",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    const edges = [
      {
        dst: "src/foo.ts",
        edge_type: "decision_touches_file" as const,
        evidence: "refs",
        src: "decision:build-a#1",
      },
    ];

    store.replaceAll(nodes, edges);
    const nodesAfterFirst = store.getAllNodes();
    const edgesAfterFirst = store.getAllEdges();

    store.replaceAll(nodes, edges);
    const nodesAfterSecond = store.getAllNodes();
    const edgesAfterSecond = store.getAllEdges();

    expect(nodesAfterSecond.length).toBe(nodesAfterFirst.length);
    expect(edgesAfterSecond.length).toBe(edgesAfterFirst.length);
    expect(nodesAfterSecond.length).toBe(2);
    expect(edgesAfterSecond.length).toBe(1);
    db.close();
  });

  test("getNodesForFile returns the decision/adr nodes linked by decision_touches_file", () => {
    const db = makeDb();
    const store = new ContextGraphStore(db);
    store.replaceAll(
      [
        {
          adr_number: null,
          body_excerpt: "touches a file",
          node_id: "decision:build-a#1",
          record_kind: "decision",
          ref_slug: "build-a",
          source_event_id: 1,
          status: null,
          title: "Touches file",
          updated_at: "2026-01-01T00:00:00Z",
        },
        {
          adr_number: null,
          body_excerpt: "unrelated",
          node_id: "decision:build-a#2",
          record_kind: "decision",
          ref_slug: "build-a",
          source_event_id: 2,
          status: null,
          title: "Unrelated",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      [
        {
          dst: "src/foo.ts",
          edge_type: "decision_touches_file",
          evidence: "refs",
          src: "decision:build-a#1",
        },
      ],
    );

    const linked = store.getNodesForFile("src/foo.ts");
    expect(linked.length).toBe(1);
    expect(linked[0].node_id).toBe("decision:build-a#1");

    expect(store.getNodesForFile("src/nowhere.ts")).toEqual([]);
    db.close();
  });

  test("getSupersedesChain returns the ordered chain and terminates on a cycle", () => {
    const db = makeDb();
    const store = new ContextGraphStore(db);
    const adrNode = (n: string) => ({
      adr_number: n,
      body_excerpt: `adr ${n}`,
      node_id: `adr:ADR-${n}`,
      record_kind: "adr" as const,
      ref_slug: null,
      source_event_id: null,
      status: "accepted",
      title: `ADR ${n}`,
      updated_at: "2026-01-01T00:00:00Z",
    });

    // Linear chain: 0003 supersedes 0002 supersedes 0001
    store.replaceAll(
      [adrNode("0001"), adrNode("0002"), adrNode("0003")],
      [
        {
          dst: "adr:ADR-0002",
          edge_type: "supersedes",
          evidence: "frontmatter",
          src: "adr:ADR-0003",
        },
        {
          dst: "adr:ADR-0001",
          edge_type: "supersedes",
          evidence: "frontmatter",
          src: "adr:ADR-0002",
        },
      ],
    );

    const chain = store.getSupersedesChain("adr:ADR-0003");
    expect(chain.map((n) => n.node_id)).toEqual(["adr:ADR-0002", "adr:ADR-0001"]);

    // Cycle: A supersedes B supersedes A — must terminate, each node once
    const store2 = new ContextGraphStore(db);
    store2.replaceAll(
      [adrNode("00a1"), adrNode("00a2")],
      [
        {
          dst: "adr:ADR-00a2",
          edge_type: "supersedes",
          evidence: "frontmatter",
          src: "adr:ADR-00a1",
        },
        {
          dst: "adr:ADR-00a1",
          edge_type: "supersedes",
          evidence: "frontmatter",
          src: "adr:ADR-00a2",
        },
      ],
    );
    const cycleChain = store2.getSupersedesChain("adr:ADR-00a1");
    expect(cycleChain.length).toBe(1);
    expect(cycleChain[0].node_id).toBe("adr:ADR-00a2");
    db.close();
  });

  test("getAllNodes / getAllEdges return [] on an empty store", () => {
    const db = makeDb();
    const store = new ContextGraphStore(db);
    expect(store.getAllNodes()).toEqual([]);
    expect(store.getAllEdges()).toEqual([]);
    db.close();
  });
});
