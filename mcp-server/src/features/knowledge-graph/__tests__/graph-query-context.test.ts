/**
 * graph-query-context.test.ts
 *
 * Tests for the two additive graph_query traversals: context_for_file and
 * supersedes_chain. Uses a real sqlite DB (via initDatabase) seeded directly
 * through ContextGraphStore.replaceAll — no mocking, since dispatch must
 * exercise the real KgQuery delegation added in m2-03.
 *
 * Also asserts existing query types (search, dead_code) are unaffected (AC R).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextGraphStore } from "@graph/kg-context-store.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { graphQuery } from "../tools/graph-query.ts";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "graph-query-context-test-"));
  mkdirSync(join(projectDir, CANON_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function dbPath(): string {
  return join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
}

function seedContextGraph(): void {
  const db = initDatabase(dbPath());
  db.prepare(
    `INSERT INTO files (path, mtime_ms, content_hash, language, last_indexed_at)
     VALUES ('src/foo.ts', 0, 'hash', 'ts', '2026-01-01T00:00:00Z')`,
  ).run();

  const store = new ContextGraphStore(db);
  store.replaceAll(
    [
      {
        adr_number: null,
        body_excerpt: "touches src/foo.ts",
        node_id: "decision:build-a#1",
        record_kind: "decision",
        ref_slug: "build-a",
        source_event_id: 1,
        status: null,
        title: "A decision",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        adr_number: "0003",
        body_excerpt: "adr 3",
        node_id: "adr:ADR-0003",
        record_kind: "adr",
        ref_slug: null,
        source_event_id: null,
        status: "accepted",
        title: "ADR 3",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        adr_number: "0002",
        body_excerpt: "adr 2",
        node_id: "adr:ADR-0002",
        record_kind: "adr",
        ref_slug: null,
        source_event_id: null,
        status: "accepted",
        title: "ADR 2",
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
      {
        dst: "adr:ADR-0002",
        edge_type: "supersedes",
        evidence: "frontmatter",
        src: "adr:ADR-0003",
      },
    ],
  );
  db.close();
}

describe("graphQuery — context_for_file", () => {
  test("returns nodes linked to a known file", () => {
    seedContextGraph();
    const result = graphQuery({ query_type: "context_for_file", target: "src/foo.ts" }, projectDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(1);
      expect((result.results[0] as { node_id: string }).node_id).toBe("decision:build-a#1");
    }
  });

  test("unknown target returns count: 0, not an error", () => {
    seedContextGraph();
    const result = graphQuery(
      { query_type: "context_for_file", target: "src/nowhere.ts" },
      projectDir,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(0);
      expect(result.results).toEqual([]);
    }
  });
});

describe("graphQuery — supersedes_chain", () => {
  test("returns the ordered supersession chain", () => {
    seedContextGraph();
    const result = graphQuery(
      { query_type: "supersedes_chain", target: "adr:ADR-0003" },
      projectDir,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(1);
      expect((result.results[0] as { node_id: string }).node_id).toBe("adr:ADR-0002");
    }
  });

  test("unknown ADR id returns count: 0, not an error", () => {
    seedContextGraph();
    const result = graphQuery(
      { query_type: "supersedes_chain", target: "adr:ADR-9999" },
      projectDir,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(0);
    }
  });
});

describe("graphQuery — existing query types unchanged (AC R)", () => {
  test("dead_code still dispatches and returns a well-formed result", () => {
    seedContextGraph();
    const result = graphQuery({ query_type: "dead_code" }, projectDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.query_type).toBe("dead_code");
      expect(Array.isArray(result.results)).toBe(true);
    }
  });

  test("search still requires a target (INVALID_INPUT)", () => {
    seedContextGraph();
    const result = graphQuery({ query_type: "search" }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});
