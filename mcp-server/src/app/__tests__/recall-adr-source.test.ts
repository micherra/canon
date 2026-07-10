import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rankAdrs } from "../recall-adr-source.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recall-adr-source-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function writeAdr(filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, "utf-8");
}

describe("rankAdrs", () => {
  it("ranks the ADR whose title/body overlaps the query first, with a namespaced id", () => {
    writeAdr(
      "0040-durable-decisions-corpus.md",
      [
        "---",
        'adr: "0040"',
        'title: "Durable orchestrator-decisions corpus via reap-time persistence"',
        "status: accepted",
        "---",
        "",
        "# ADR-0040: Durable orchestrator-decisions corpus",
        "",
        "Canon's decisions ledger needs a durable cross-workspace corpus.",
      ].join("\n"),
    );
    writeAdr(
      "0005-knowledge-graph-is-a-foundational-service.md",
      [
        "---",
        'adr: "0005"',
        'title: "Knowledge graph is a foundational service"',
        "status: accepted",
        "---",
        "",
        "# ADR-0005",
        "",
        "features may depend on the knowledge graph.",
      ].join("\n"),
    );

    const hits = rankAdrs("durable decisions corpus", dir, 10);

    expect(hits[0].id).toBe("adr:ADR-0040");
    expect(hits[0].source_store).toBe("adr");
    expect(hits[0].path).toBe("docs/adr/0040-durable-decisions-corpus.md");
  });

  it("returns [] for a missing directory", () => {
    expect(rankAdrs("anything", join(dir, "does-not-exist"), 10)).toEqual([]);
  });

  it("skips a malformed-frontmatter ADR but still returns the others", () => {
    writeAdr("0001-bad.md", "---\nadr: [unterminated\n---\ntitle here durable decisions");
    writeAdr(
      "0002-good.md",
      [
        "---",
        'adr: "0002"',
        'title: "Durable decisions good"',
        "---",
        "",
        "durable decisions body",
      ].join("\n"),
    );

    const hits = rankAdrs("durable decisions", dir, 10);

    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("adr:ADR-0002");
  });

  it("caps results with limit and orders ties deterministically by ADR number", () => {
    for (const num of ["0003", "0001", "0002"]) {
      writeAdr(
        `${num}-tie.md`,
        ["---", `adr: "${num}"`, 'title: "Tie durable"', "---", "durable"].join("\n"),
      );
    }

    const hits = rankAdrs("durable", dir, 2);

    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.id)).toEqual(["adr:ADR-0001", "adr:ADR-0002"]);
  });

  it("produces a non-empty, whitespace-collapsed snippet with a docs/adr/ path", () => {
    writeAdr(
      "0009-snippet.md",
      [
        "---",
        'adr: "0009"',
        'title: "Snippet formatting"',
        "---",
        "",
        "durable   decisions\n\n  with   irregular   whitespace",
      ].join("\n"),
    );

    const hits = rankAdrs("durable decisions", dir, 10);

    expect(hits[0].snippet.length).toBeGreaterThan(0);
    expect(hits[0].snippet).not.toMatch(/\s{2,}/);
    expect(hits[0].path?.startsWith("docs/adr/")).toBe(true);
  });

  it("returns [] when the query has no tokens of sufficient length", () => {
    writeAdr("0001-x.md", ["---", 'adr: "0001"', 'title: "Something"', "---", "body"].join("\n"));
    expect(rankAdrs("to a", dir, 10)).toEqual([]);
  });
});
