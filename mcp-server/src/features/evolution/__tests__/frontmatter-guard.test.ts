/**
 * frontmatter-guard.test.ts — pure unit tests for checkFrontmatterImmutable (TASK-003).
 *
 * Fail-closed: unparseable frontmatter -> reject, never throw.
 */

import { describe, expect, it } from "vitest";
import {
  checkFrontmatterImmutable,
  checkPrincipleFrontmatterImmutable,
} from "../services/frontmatter-guard.ts";

const BASELINE =
  "---\nname: engineer\ntools: [Read, Write]\nmodel: sonnet\n---\n\n# Role\n\nWrite code.\n";

describe("checkFrontmatterImmutable", () => {
  it("identical frontmatter, changed body -> ok:true", () => {
    const candidate =
      "---\nname: engineer\ntools: [Read, Write]\nmodel: sonnet\n---\n\n# Role\n\nWrite BETTER code.\n";
    expect(checkFrontmatterImmutable(BASELINE, candidate)).toEqual({ ok: true });
  });

  it("edited tools: line -> frontmatter_modified with fields:['tools']", () => {
    const candidate =
      "---\nname: engineer\ntools: [Read]\nmodel: sonnet\n---\n\n# Role\n\nWrite code.\n";
    const result = checkFrontmatterImmutable(BASELINE, candidate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("frontmatter_modified");
    expect(result.fields).toContain("tools");
  });

  it("edited name: line -> frontmatter_modified with fields:['name']", () => {
    const candidate =
      "---\nname: reviewer\ntools: [Read, Write]\nmodel: sonnet\n---\n\n# Role\n\nWrite code.\n";
    const result = checkFrontmatterImmutable(BASELINE, candidate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("frontmatter_modified");
    expect(result.fields).toContain("name");
  });

  it("edited model: line -> frontmatter_modified with fields:['model']", () => {
    const candidate =
      "---\nname: engineer\ntools: [Read, Write]\nmodel: opus\n---\n\n# Role\n\nWrite code.\n";
    const result = checkFrontmatterImmutable(BASELINE, candidate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("frontmatter_modified");
    expect(result.fields).toContain("model");
  });

  it("removed frontmatter entirely -> frontmatter_modified", () => {
    const candidate = "# Role\n\nWrite code.\n";
    const result = checkFrontmatterImmutable(BASELINE, candidate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("frontmatter_modified");
  });

  it("added frontmatter where baseline had none -> frontmatter_modified", () => {
    const noFmBaseline = "# Role\n\nWrite code.\n";
    const candidate = "---\nname: engineer\n---\n\n# Role\n\nWrite code.\n";
    const result = checkFrontmatterImmutable(noFmBaseline, candidate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("frontmatter_modified");
  });

  it("malformed candidate YAML -> frontmatter_unverifiable (no throw)", () => {
    const candidate = "---\n[unclosed: [nested\n---\n\n# Role\n\nWrite code.\n";
    expect(() => checkFrontmatterImmutable(BASELINE, candidate)).not.toThrow();
    const result = checkFrontmatterImmutable(BASELINE, candidate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("frontmatter_unverifiable");
  });

  it("malformed baseline YAML -> frontmatter_unverifiable (no throw)", () => {
    const malformedBaseline = "---\n[unclosed: [nested\n---\n\n# Role\n\nWrite code.\n";
    expect(() => checkFrontmatterImmutable(malformedBaseline, BASELINE)).not.toThrow();
    const result = checkFrontmatterImmutable(malformedBaseline, BASELINE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("frontmatter_unverifiable");
  });

  it("no frontmatter on either side, body-only diff -> ok:true", () => {
    expect(checkFrontmatterImmutable("# A\n\nBody one.\n", "# A\n\nBody two.\n")).toEqual({
      ok: true,
    });
  });

  it("key reordering with identical values is caught by raw-block byte comparison", () => {
    // Raw-block comparison (not semantic-data comparison) — reordering IS a modification.
    const candidate =
      "---\ntools: [Read, Write]\nname: engineer\nmodel: sonnet\n---\n\n# Role\n\nWrite code.\n";
    const result = checkFrontmatterImmutable(BASELINE, candidate);
    expect(result.ok).toBe(false);
  });

  it("never throws on empty strings", () => {
    expect(() => checkFrontmatterImmutable("", "")).not.toThrow();
    expect(checkFrontmatterImmutable("", "")).toEqual({ ok: true });
  });
});

const PRINCIPLE_BASELINE =
  "---\nid: some-principle\nseverity: convention\n---\n\n# Some Principle\n\nOriginal body.\n";

describe("checkPrincipleFrontmatterImmutable (retire-only archived tolerance)", () => {
  it("REWRITE (isRetire omitted): a candidate that flips archived:true is rejected — the archived exception is retire-only", () => {
    const candidate =
      "---\nid: some-principle\nseverity: convention\narchived: true\n---\n\n# Some Principle\n\nOriginal body.\n";
    const result = checkPrincipleFrontmatterImmutable(PRINCIPLE_BASELINE, candidate);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("frontmatter_modified");
    expect(result.fields).toContain("archived");
  });

  it("REWRITE (isRetire: false, explicit): same reject as omitted", () => {
    const candidate =
      "---\nid: some-principle\nseverity: convention\narchived: true\n---\n\n# Some Principle\n\nOriginal body.\n";
    const result = checkPrincipleFrontmatterImmutable(PRINCIPLE_BASELINE, candidate, false);
    expect(result.ok).toBe(false);
  });

  it("RETIRE (isRetire: true): a candidate that flips archived:true is tolerated", () => {
    const candidate =
      "---\nid: some-principle\nseverity: convention\narchived: true\n---\n\n# Some Principle\n\nOriginal body.\n";
    expect(checkPrincipleFrontmatterImmutable(PRINCIPLE_BASELINE, candidate, true)).toEqual({
      ok: true,
    });
  });

  it("RETIRE (isRetire: true): every OTHER field must still stay byte-identical", () => {
    const candidate =
      "---\nid: some-principle\nseverity: rule\narchived: true\n---\n\n# Some Principle\n\nOriginal body.\n";
    const result = checkPrincipleFrontmatterImmutable(PRINCIPLE_BASELINE, candidate, true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.fields).toContain("severity");
    expect(result.fields).not.toContain("archived");
  });

  it("body-only diff (isRetire omitted) -> ok:true, unaffected by the retire-only change", () => {
    const candidate =
      "---\nid: some-principle\nseverity: convention\n---\n\n# Some Principle\n\nBETTER body.\n";
    expect(checkPrincipleFrontmatterImmutable(PRINCIPLE_BASELINE, candidate)).toEqual({
      ok: true,
    });
  });

  it("malformed candidate YAML -> frontmatter_unverifiable regardless of isRetire", () => {
    const candidate = "---\n[unclosed: [nested\n---\n\n# Some Principle\n\nOriginal body.\n";
    const result = checkPrincipleFrontmatterImmutable(PRINCIPLE_BASELINE, candidate, true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("frontmatter_unverifiable");
  });
});
