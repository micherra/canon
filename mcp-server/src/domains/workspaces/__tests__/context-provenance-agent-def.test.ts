/**
 * Tests for the agent-def provenance artifact (TASK-001): `computeBodySections` and the
 * `agentDef` branch of `buildContextProvenanceRecord`.
 *
 * Split out of context-provenance.test.ts to stay under the 600-line file cap
 * (noExcessiveLinesPerFile) — same split-by-concern pattern as the
 * resolve-agent-skills*.test.ts family.
 */

import { describe, expect, it } from "vitest";
import {
  buildContextProvenanceRecord,
  computeBodySections,
  hashContent,
  type SectionSpan,
} from "../context-provenance.js";

describe("computeBodySections", () => {
  it("excludes frontmatter from every section span (all starts >= frontmatterEnd)", () => {
    const fullFile =
      "---\nname: engineer\ntools: [Read, Write]\n---\n\n# Role\n\nDo the work.\n\n## Guardrails\n\nBe careful.\n";
    const { frontmatterEnd, sections } = computeBodySections(fullFile);

    expect(frontmatterEnd).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.span[0]).toBeGreaterThanOrEqual(frontmatterEnd);
      expect(section.span[1]).toBeGreaterThanOrEqual(section.span[0]);
    }
  });

  it("splits the body on ATX headings; each section spans heading to next heading/EOF", () => {
    const fullFile = "---\nname: x\n---\n# Role\n\nBody one.\n\n## Guardrails\n\nBody two.\n";
    const { sections } = computeBodySections(fullFile);

    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("# Role");
    expect(sections[1].heading).toBe("## Guardrails");
    // slicing the full file at each span reproduces exactly the section text
    for (const section of sections) {
      const [start, end] = section.span;
      expect(fullFile.slice(start, end)).toContain(section.heading);
    }
    // sections are contiguous and cover the whole body
    expect(sections[0].span[1]).toBe(sections[1].span[0]);
    expect(sections[1].span[1]).toBe(fullFile.length);
  });

  it("treats pre-heading preamble as one section with heading ''", () => {
    const fullFile = "---\nname: x\n---\nPreamble text.\n\n# First Heading\n\nMore.\n";
    const { sections } = computeBodySections(fullFile);

    expect(sections[0].heading).toBe("");
    expect(sections[1].heading).toBe("# First Heading");
  });

  it("handles an empty body with no sections", () => {
    const fullFile = "---\nname: x\n---\n";
    const { sections } = computeBodySections(fullFile);
    expect(sections).toEqual([]);
  });

  it("handles a body with no headings as a single preamble-only section", () => {
    const fullFile = "---\nname: x\n---\nJust plain body text, no headings at all.\n";
    const { sections } = computeBodySections(fullFile);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("");
  });

  it("handles a file with no frontmatter fence (frontmatterEnd 0)", () => {
    const fullFile = "# No Frontmatter\n\nJust a body.\n";
    const { frontmatterEnd, sections } = computeBodySections(fullFile);
    expect(frontmatterEnd).toBe(0);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("# No Frontmatter");
  });

  it("never throws on malformed frontmatter YAML (fail-open)", () => {
    const fullFile = "---\n[unclosed: [nested\n---\n# Heading\n\nBody.\n";
    expect(() => computeBodySections(fullFile)).not.toThrow();
  });

  it("malformed frontmatter YAML never yields a section span overlapping the frontmatter fence", () => {
    // splitFrontmatter throws on this input (unclosed bracket) — the catch branch must not
    // fall back to treating the WHOLE file (frontmatter included) as one mutable section.
    const fullFile = "---\n[unclosed: [nested\n---\n# Heading\n\nBody.\n";
    const { sections } = computeBodySections(fullFile);
    // No section may claim the frontmatter fence — the only safe fail-open answer when
    // we can't locate the body boundary is to emit no mutable spans at all.
    expect(sections).toEqual([]);
  });

  it("never throws on empty input", () => {
    expect(() => computeBodySections("")).not.toThrow();
    expect(computeBodySections("").sections).toEqual([]);
  });
});

describe("buildContextProvenanceRecord — agent-def artifact", () => {
  const baseInput = {
    workspace: "ws-123",
    stepId: "step-01",
    agentName: "canon:engineer",
    spawnedAt: "2026-06-23T12:00:00.000Z",
    finalPreloadPrompt: "",
    skills: [],
  };

  it("appends exactly one agent-def artifact when agentDef input is present", () => {
    const fullFile = "---\nname: engineer\ntools: [Read, Write]\n---\n\n# Role\n\nDo work.\n";
    const record = buildContextProvenanceRecord({
      ...baseInput,
      agentDef: { path: "agents/engineer.md", fullFile },
    });

    const agentDefArtifacts = record.assembled_artifacts.filter((a) => a.kind === "agent-def");
    expect(agentDefArtifacts).toHaveLength(1);
    expect(agentDefArtifacts[0].path).toBe("agents/engineer.md");
    expect(agentDefArtifacts[0].id).toBe("engineer");
  });

  it("content_hash is sha256 of the WHOLE file (frontmatter included)", () => {
    const fullFile = "---\nname: engineer\n---\n\n# Role\n\nDo work.\n";
    const record = buildContextProvenanceRecord({
      ...baseInput,
      agentDef: { path: "agents/engineer.md", fullFile },
    });
    const artifact = record.assembled_artifacts.find((a) => a.kind === "agent-def");
    expect(artifact?.content_hash).toBe(hashContent(fullFile));
  });

  it("char_span is null for the agent-def artifact (body not in preload_prompt)", () => {
    const fullFile = "---\nname: engineer\n---\n\n# Role\n\nDo work.\n";
    const record = buildContextProvenanceRecord({
      ...baseInput,
      agentDef: { path: "agents/engineer.md", fullFile },
    });
    const artifact = record.assembled_artifacts.find((a) => a.kind === "agent-def");
    expect(artifact?.char_span).toBeNull();
  });

  it("trust_tier is 'trusted' for the agent-def artifact", () => {
    const fullFile = "---\nname: engineer\n---\n\n# Role\n\nDo work.\n";
    const record = buildContextProvenanceRecord({
      ...baseInput,
      agentDef: { path: "agents/engineer.md", fullFile },
    });
    const artifact = record.assembled_artifacts.find((a) => a.kind === "agent-def");
    expect(artifact?.trust_tier).toBe("trusted");
  });

  it("carries sections[] whose starts are all >= frontmatter end (no overlap with frontmatter)", () => {
    const fullFile =
      "---\nname: engineer\ntools: [Read]\n---\n\n# Role\n\nBody.\n\n## Guardrails\n\nMore.\n";
    const record = buildContextProvenanceRecord({
      ...baseInput,
      agentDef: { path: "agents/engineer.md", fullFile },
    });
    const artifact = record.assembled_artifacts.find((a) => a.kind === "agent-def");
    const { frontmatterEnd } = computeBodySections(fullFile);
    expect(artifact?.sections).toBeDefined();
    for (const section of artifact?.sections as SectionSpan[]) {
      expect(section.span[0]).toBeGreaterThanOrEqual(frontmatterEnd);
    }
  });

  it("no field on the agent-def artifact holds def-body prose — only hash + spans + heading labels", () => {
    const fullFile = "---\nname: engineer\n---\n\n# Role\n\nSecret instructions here.\n";
    const record = buildContextProvenanceRecord({
      ...baseInput,
      agentDef: { path: "agents/engineer.md", fullFile },
    });
    const artifact = record.assembled_artifacts.find((a) => a.kind === "agent-def");
    const serialized = JSON.stringify(artifact);
    // Body prose (paragraph content) is never present — sections carry heading labels + spans only.
    expect(serialized).not.toContain("Secret instructions here");
  });

  it("non-agent-def artifacts are unaffected when agentDef is absent", () => {
    const record = buildContextProvenanceRecord({ ...baseInput, finalPreloadPrompt: "" });
    expect(record.assembled_artifacts).toEqual([]);
  });

  it("handles malformed agent-def frontmatter without throwing (fail-open)", () => {
    const fullFile = "---\n[bad yaml\n---\n# Heading\n\nBody.\n";
    expect(() =>
      buildContextProvenanceRecord({
        ...baseInput,
        agentDef: { path: "agents/engineer.md", fullFile },
      }),
    ).not.toThrow();
  });

  it("malformed agent-def frontmatter never yields a mutable section overlapping the frontmatter fence", () => {
    const fullFile = "---\n[bad yaml\n---\n# Heading\n\nBody.\n";
    const record = buildContextProvenanceRecord({
      ...baseInput,
      agentDef: { path: "agents/engineer.md", fullFile },
    });
    const artifact = record.assembled_artifacts.find((a) => a.kind === "agent-def");
    expect(artifact?.sections).toEqual([]);
  });

  it("handles an empty-body agent-def file without throwing", () => {
    const fullFile = "---\nname: engineer\n---\n";
    expect(() =>
      buildContextProvenanceRecord({
        ...baseInput,
        agentDef: { path: "agents/engineer.md", fullFile },
      }),
    ).not.toThrow();
  });
});
