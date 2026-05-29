/**
 * Tests for doc-freshness-adapter.ts
 *
 * Validates the single-signal staleness decay confidence scoring:
 * - A freshly synced doc (0–few commits behind) → high confidence.
 * - A clearly stale doc (≥ saturation, including the watch_ZZZ1 ~87-commit signal)
 *   → low confidence, NOT masked as "insufficient".
 * - The decay reuses the shared computeConfidenceAnnotation engine (no bespoke decay).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeFreshnessConfidence } from "../doc-freshness-adapter.ts";

describe("computeFreshnessConfidence", () => {
  it("fresh doc (0 commits) → tier high, score >= 0.7", () => {
    const result = computeFreshnessConfidence({ commits_since_sync: 0, doc_path: "docs/x.md" });
    expect(result.tier).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  it("a few commits (5) stays high", () => {
    const result = computeFreshnessConfidence({ commits_since_sync: 5, doc_path: "docs/x.md" });
    // value = 1 - 5/40 = 0.875 → high
    expect(result.tier).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  it("moderately stale doc (30 commits) → tier low (decayed below threshold)", () => {
    const result = computeFreshnessConfidence({ commits_since_sync: 30, doc_path: "docs/x.md" });
    // value = 1 - 30/40 = 0.25 → low
    expect(result.tier).toBe("low");
    expect(result.score).toBeLessThan(0.4);
  });

  it("at saturation (40 commits) → score 0", () => {
    const result = computeFreshnessConfidence({ commits_since_sync: 40, doc_path: "docs/x.md" });
    expect(result.score).toBe(0);
    expect(result.tier).toBe("low");
  });

  it("watch_ZZZ1 signal (87 commits) → tier low, NOT insufficient (sample floor not hit)", () => {
    const result = computeFreshnessConfidence({ commits_since_sync: 87, doc_path: "docs/x.md" });
    // commits beyond saturation floor the value at 0, but sample_size = 10 ≥ 5
    // so deriveTier must return "low", never "insufficient".
    expect(result.tier).toBe("low");
    expect(result.tier).not.toBe("insufficient");
    expect(result.sample_size).toBeGreaterThanOrEqual(5);
  });

  it("non-finite commit count is treated as fully stale, never insufficient", () => {
    const result = computeFreshnessConfidence({
      commits_since_sync: Number.NaN,
      doc_path: "docs/x.md",
    });
    expect(result.tier).toBe("low");
    expect(result.sample_size).toBeGreaterThanOrEqual(5);
  });

  it("negative commit count (-1 sentinel for unknown) is treated as fully stale", () => {
    const result = computeFreshnessConfidence({
      commits_since_sync: -1,
      doc_path: "docs/x.md",
    });
    expect(result.tier).toBe("low");
    expect(result.score).toBe(0);
    expect(result.sample_size).toBeGreaterThanOrEqual(5);
  });

  it("uses the single staleness signal (no auxiliary decay signals)", () => {
    const result = computeFreshnessConfidence({ commits_since_sync: 0, doc_path: "docs/x.md" });
    const signals = result.basis.map((b) => b.signal);
    expect(signals).toEqual(["staleness"]);
  });

  it("staleness is monotonically decreasing in commits_since_sync", () => {
    const fresh = computeFreshnessConfidence({ commits_since_sync: 0, doc_path: "docs/x.md" });
    const mid = computeFreshnessConfidence({ commits_since_sync: 20, doc_path: "docs/x.md" });
    const stale = computeFreshnessConfidence({ commits_since_sync: 40, doc_path: "docs/x.md" });
    expect(fresh.score).toBeGreaterThan(mid.score);
    expect(mid.score).toBeGreaterThan(stale.score);
  });

  // AC5 — import-shape assertion: the adapter MUST reuse the shared engine
  // (computeConfidenceAnnotation), never a bespoke decay function.
  it("reuses computeConfidenceAnnotation from the shared kernel (no bespoke decay)", () => {
    const source = readFileSync(join(__dirname, "..", "doc-freshness-adapter.ts"), "utf-8");
    expect(source).toContain("computeConfidenceAnnotation");
    expect(source).toContain("@shared/lib/confidence.ts");
    // No parallel decay implementation: the only math is the signal-value mapping.
    expect(source).not.toMatch(/Math\.exp/);
    expect(source).not.toMatch(/Math\.pow/);
  });
});
