import { describe, expect, it } from "vitest";
import type { RecallCandidate } from "../recall-fusion.ts";
import { rrfFuse } from "../recall-fusion.ts";

function candidate(overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    id: "entity:1",
    snippet: "snippet",
    source_store: "code_kg",
    ...overrides,
  };
}

describe("rrfFuse", () => {
  it("preserves order and computes rrf = weight / (k + rank) for a single store", () => {
    const a = candidate({ id: "entity:1", snippet: "first" });
    const b = candidate({ id: "entity:2", snippet: "second" });
    const c = candidate({ id: "entity:3", snippet: "third" });

    const hits = rrfFuse({ code_kg: [a, b, c] });

    expect(hits.map((h) => h.id)).toEqual(["entity:1", "entity:2", "entity:3"]);
    expect(hits[0]).toMatchObject({ native_rank: 1, rrf_score: 1 / (60 + 1) });
    expect(hits[1]).toMatchObject({ native_rank: 2, rrf_score: 1 / (60 + 2) });
    expect(hits[2]).toMatchObject({ native_rank: 3, rrf_score: 1 / (60 + 3) });
  });

  it("sums contributions for an id appearing in two stores, boosting it above single-store peers", () => {
    const shared = candidate({ id: "shared:1", source_store: "code_kg" });
    const codeOnly = candidate({ id: "entity:2", source_store: "code_kg" });
    const sharedInKnowledge = candidate({
      id: "shared:1",
      snippet: "from knowledge",
      source_store: "knowledge",
    });
    const knowledgeOnly = candidate({ id: "doc:1", source_store: "knowledge" });

    const hits = rrfFuse({
      code_kg: [shared, codeOnly],
      knowledge: [sharedInKnowledge, knowledgeOnly],
    });

    const sharedHit = hits.find((h) => h.id === "shared:1");
    expect(sharedHit).toBeDefined();
    expect(sharedHit?.rrf_score).toBeCloseTo(1 / (60 + 1) + 1 / (60 + 1), 10);
    // The shared doc outranks every single-store peer.
    expect(hits[0].id).toBe("shared:1");
    // Best (lowest) native_rank and highest-ranked occurrence's fields are kept — both
    // occurrences are rank 1, so the first-seen (code_kg) fields win.
    expect(sharedHit?.native_rank).toBe(1);
    expect(sharedHit?.source_store).toBe("code_kg");
  });

  it("is deterministic — identical inputs produce identical output ordering, including tie-breaks", () => {
    const tiedA = candidate({ id: "b:1", source_store: "adr" });
    const tiedB = candidate({ id: "a:1", source_store: "build_history" });
    const perStore = { adr: [tiedA], build_history: [tiedB] };

    const first = rrfFuse(perStore);
    const second = rrfFuse(perStore);

    expect(first).toEqual(second);
    // Equal rrf_score (both rank 1, weight 1) → tie-break by (source_store ASC, id ASC).
    expect(first.map((h) => h.source_store)).toEqual(["adr", "build_history"]);
  });

  it("applies limit after fusion, and k/weights overrides change scores as expected", () => {
    const candidates = [candidate({ id: "e1" }), candidate({ id: "e2" }), candidate({ id: "e3" })];

    const limited = rrfFuse({ code_kg: candidates }, { limit: 2 });
    expect(limited).toHaveLength(2);

    const defaultK = rrfFuse({ code_kg: [candidates[0]] });
    const customK = rrfFuse({ code_kg: [candidates[0]] }, { k: 10 });
    expect(defaultK[0].rrf_score).toBeCloseTo(1 / (60 + 1), 10);
    expect(customK[0].rrf_score).toBeCloseTo(1 / (10 + 1), 10);

    const weighted = rrfFuse({ code_kg: [candidates[0]] }, { weights: { code_kg: 2 } });
    expect(weighted[0].rrf_score).toBeCloseTo(2 / (60 + 1), 10);
  });

  it("returns [] for empty input, and a store with [] contributes nothing", () => {
    expect(rrfFuse({})).toEqual([]);

    const hits = rrfFuse({ adr: [], code_kg: [candidate({ id: "e1" })] });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("e1");
  });

  it("never throws on degenerate input", () => {
    expect(() => rrfFuse({})).not.toThrow();
    expect(() => rrfFuse({ code_kg: [] })).not.toThrow();
  });
});
