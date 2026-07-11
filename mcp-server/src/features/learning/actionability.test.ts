import { describe, expect, it } from "vitest";
import { ACTIONABLE_TYPES, classifyProposal, INFORMATIONAL_TYPES } from "./actionability.ts";

describe("classifyProposal — actionable types (YAML frontmatter)", () => {
  for (const type of ACTIONABLE_TYPES) {
    it(`classifies type: ${type} as actionable`, () => {
      const result = classifyProposal({
        filename: `zz_${type}-fixture.md`,
        frontmatter: `---\nid: zz_fixture\ntype: ${type}\n---\n`,
      });
      expect(result.actionability).toBe("actionable");
    });
  }
});

describe("classifyProposal — informational types (YAML frontmatter)", () => {
  for (const type of INFORMATIONAL_TYPES) {
    it(`classifies type: ${type} as informational`, () => {
      const result = classifyProposal({
        filename: `zz_${type}-fixture.md`,
        frontmatter: `---\nid: zz_fixture\ntype: ${type}\n---\n`,
      });
      expect(result.actionability).toBe("informational");
    });
  }
});

describe("classifyProposal — legacy bold pseudo-frontmatter", () => {
  it("classifies an actionable type declared via **Type**: bold line", () => {
    const result = classifyProposal({
      filename: "sug_LEGACY1-fixture.md",
      frontmatter: "**ID**: sug_LEGACY1\n**Type**: new-convention\n**Status**: proposed\n",
    });
    expect(result.actionability).toBe("actionable");
  });

  it("classifies an informational type declared via **Type**: bold line", () => {
    const result = classifyProposal({
      filename: "watch_LEGACY1-fixture.md",
      frontmatter: "**ID**: watch_LEGACY1\n**Type**: applied-observation\n**Status**: resolved\n",
    });
    expect(result.actionability).toBe("informational");
  });

  it("prefers YAML type: over a coincidental bold line when both are present", () => {
    const result = classifyProposal({
      filename: "sug_MIXED1-fixture.md",
      frontmatter: "---\nid: sug_MIXED1\ntype: new-convention\n---\n\n**Type**: watch\n",
    });
    expect(result.actionability).toBe("actionable");
  });
});

describe("classifyProposal — filename-prefix fallback (no type field)", () => {
  it("falls back to actionable for sug_ prefix", () => {
    const result = classifyProposal({
      filename: "sug_NOTYPE1-fixture.md",
      frontmatter: "---\nid: sug_NOTYPE1\nconfidence: high\n---\n",
    });
    expect(result.actionability).toBe("actionable");
  });

  it("falls back to actionable for convention_ prefix", () => {
    const result = classifyProposal({
      filename: "convention_NOTYPE1-fixture.md",
      frontmatter: "---\nid: convention_NOTYPE1\n---\n",
    });
    expect(result.actionability).toBe("actionable");
  });

  it("falls back to informational for watch_ prefix", () => {
    const result = classifyProposal({
      filename: "watch_NOTYPE1-fixture.md",
      frontmatter: "---\nid: watch_NOTYPE1\n---\n",
    });
    expect(result.actionability).toBe("informational");
  });

  it("falls back to informational for note_ prefix", () => {
    const result = classifyProposal({
      filename: "note_NOTYPE1-fixture.md",
      frontmatter: "---\nid: note_NOTYPE1\n---\n",
    });
    expect(result.actionability).toBe("informational");
  });
});

describe("classifyProposal — unclassified conservative default", () => {
  it("classifies as informational when no type field and no recognized prefix", () => {
    const result = classifyProposal({
      filename: "mystery-fixture.md",
      frontmatter: "---\nid: mystery-fixture\n---\n",
    });
    expect(result.actionability).toBe("informational");
  });

  it("classifies as informational when the declared type is unknown and the prefix is unrecognized", () => {
    const result = classifyProposal({
      filename: "mystery-fixture.md",
      frontmatter: "---\nid: mystery-fixture\ntype: totally-unknown-type\n---\n",
    });
    expect(result.actionability).toBe("informational");
  });
});
