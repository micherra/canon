/**
 * ensure-context-graph-fresh.test.ts
 *
 * Tests for ensureContextGraphFresh — the lazy content-hash freshness gate
 * for the context graph (decisions/ADRs). Mirrors
 * ensure-doc-corpus-fresh.test.ts patterns.
 *
 * NOTE (deviation from the m2-02 task plan, discovered during implementation):
 * the plan's signature is `ensureContextGraphFresh(dbPath, projectDir,
 * pluginDir)`, calling `buildDecisionsCorpus(projectDir)` internally. That
 * import is forbidden here too — `features/knowledge-graph/` may not import
 * `features/orchestration/**` (`no-cross-feature-internal-import`; the
 * ADR-0005 allowance only runs the other direction). So `decisions` is a
 * parameter, resolved by the composition-root caller
 * (`app/register-knowledge.ts`) — see `kg-context-ingest.ts`'s docstring for
 * the full rationale.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureContextGraphFresh } from "@features/knowledge-graph/ensure-context-graph-fresh.ts";
import type { IngestableDecision } from "@graph/kg-context-ingest.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { CONTEXT_GRAPH_HASH_KEY } from "@shared/constants.ts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock ingestContextGraph so tests don't exercise the full derive pipeline.
vi.mock("@graph/kg-context-ingest.ts", async () => {
  const actual = await vi.importActual<typeof import("@graph/kg-context-ingest.ts")>(
    "@graph/kg-context-ingest.ts",
  );
  return {
    ...actual,
    ingestContextGraph: vi.fn().mockReturnValue({ edge_count: 0, node_count: 0 }),
  };
});

import { ingestContextGraph } from "@graph/kg-context-ingest.ts";

let tempDir: string;
let projectDir: string;
let pluginDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `ensure-context-fresh-test-${Date.now()}-${Math.random()}`);
  projectDir = join(tempDir, "project");
  pluginDir = join(tempDir, "plugin");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(pluginDir, { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeDbPath(): string {
  return join(tempDir, "knowledge-graph.db");
}

function makeDecisions(overrides: Partial<IngestableDecision> = {}): IngestableDecision[] {
  return [
    {
      decided_at: "2026-01-01T00:00:00Z",
      decision_type: "plan_approval",
      source_event_id: 1,
      source_slug: "build-a",
      summary: "Approved",
      ...overrides,
    },
  ];
}

function writeAdr(filename: string, content = '---\nadr: "0001"\n---\n\nBody.\n'): void {
  const adrDir = join(pluginDir, "docs", "adr");
  mkdirSync(adrDir, { recursive: true });
  writeFileSync(join(adrDir, filename), content);
}

describe("ensureContextGraphFresh", () => {
  test("no-op when DB file does not exist", async () => {
    const dbPath = join(tempDir, "nonexistent.db");
    await ensureContextGraphFresh(dbPath, makeDecisions(), projectDir, pluginDir);
    expect(ingestContextGraph).not.toHaveBeenCalled();
  });

  test("unchanged inputs → hash marker matches → no re-ingest", async () => {
    const dbPath = makeDbPath();
    const db = initDatabase(dbPath);
    db.close();

    await ensureContextGraphFresh(dbPath, makeDecisions(), projectDir, pluginDir);
    expect(ingestContextGraph).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    await ensureContextGraphFresh(dbPath, makeDecisions(), projectDir, pluginDir);
    expect(ingestContextGraph).not.toHaveBeenCalled();
  });

  test("new decision appended without a git commit re-fires (content-hash, not git-HEAD)", async () => {
    // Decisions are an append-only event ledger — the corpus "mutates" by
    // gaining new events (new source_event_id), not by editing existing
    // ones. The hash signature is over the id set for exactly this reason.
    const dbPath = makeDbPath();
    const db = initDatabase(dbPath);
    db.close();

    await ensureContextGraphFresh(dbPath, makeDecisions(), projectDir, pluginDir);
    expect(ingestContextGraph).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    // No git commit occurred — purely a new in-store decision event.
    const grown = [...makeDecisions(), ...makeDecisions({ source_event_id: 2 })];
    await ensureContextGraphFresh(dbPath, grown, projectDir, pluginDir);
    expect(ingestContextGraph).toHaveBeenCalledTimes(1);
  });

  test("ADR file added → hash changes → re-ingest fires", async () => {
    const dbPath = makeDbPath();
    const db = initDatabase(dbPath);
    db.close();

    await ensureContextGraphFresh(dbPath, makeDecisions(), projectDir, pluginDir);
    expect(ingestContextGraph).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    writeAdr("0001-first-adr.md");
    await ensureContextGraphFresh(dbPath, makeDecisions(), projectDir, pluginDir);
    expect(ingestContextGraph).toHaveBeenCalledTimes(1);
  });

  test("marker stored in meta table under CONTEXT_GRAPH_HASH_KEY, hex-looking (sha256)", async () => {
    const dbPath = makeDbPath();
    const db1 = initDatabase(dbPath);
    db1.close();

    await ensureContextGraphFresh(dbPath, makeDecisions(), projectDir, pluginDir);

    const db2 = initDatabase(dbPath);
    const row = db2.prepare(`SELECT value FROM meta WHERE key = ?`).get(CONTEXT_GRAPH_HASH_KEY) as
      | { value: string }
      | undefined;
    db2.close();

    expect(row).toBeDefined();
    expect(row!.value).toMatch(/^[0-9a-f]{64}$/);
  });

  test("forced-error path serves last-good without throwing (fail-open)", async () => {
    const dbPath = makeDbPath();
    const db = initDatabase(dbPath);
    db.close();

    (ingestContextGraph as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await expect(
      ensureContextGraphFresh(dbPath, makeDecisions(), projectDir, pluginDir),
    ).resolves.not.toThrow();

    // Hash must NOT have been stamped since ingest threw — next call retries.
    const db2 = initDatabase(dbPath);
    const row = db2.prepare(`SELECT value FROM meta WHERE key = ?`).get(CONTEXT_GRAPH_HASH_KEY) as
      | { value: string }
      | undefined;
    db2.close();
    expect(row).toBeUndefined();
  });

  test("concurrent callers deduplicate — only one ingest runs per stale cycle", async () => {
    const dbPath = makeDbPath();
    const db = initDatabase(dbPath);
    db.close();

    await Promise.all([
      ensureContextGraphFresh(dbPath, makeDecisions(), projectDir, pluginDir),
      ensureContextGraphFresh(dbPath, makeDecisions(), projectDir, pluginDir),
    ]);

    expect(ingestContextGraph).toHaveBeenCalledTimes(1);
  });
});
