import { describe, expect, it } from "vitest";
import {
  type AssembledArtifact,
  buildContextProvenanceRecord,
  type ContextProvenanceRecord,
  type ContextProvenanceSummary,
  hashContent,
  type ProvenanceArtifactKind,
} from "../context-provenance.js";

// Known sha256 of "hello world" (utf-8, no newline)
const HELLO_WORLD_SHA256 = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

describe("hashContent", () => {
  it("is deterministic and equals a known sha256 for a fixed input", () => {
    expect(hashContent("hello world")).toBe(HELLO_WORLD_SHA256);
    // Calling twice yields same result
    expect(hashContent("hello world")).toBe(hashContent("hello world"));
  });

  it("returns different hashes for different inputs", () => {
    expect(hashContent("hello world")).not.toBe(hashContent("Hello World"));
    expect(hashContent("")).not.toBe(hashContent("a"));
  });
});

describe("buildContextProvenanceRecord", () => {
  const baseInput = {
    workspace: "ws-123",
    stepId: "step-01",
    agentName: "canon:engineer",
    spawnedAt: "2026-06-23T12:00:00.000Z",
    finalPreloadPrompt: "",
    skills: [],
  };

  describe("non-blanked artifact: span correctness", () => {
    it("locates the inContextText within finalPreloadPrompt and sets correct char_span", () => {
      const inContextText = "This is the primer content.";
      const finalPreloadPrompt = `Preamble text. ${inContextText} Postamble text.`;

      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt,
        skills: [
          {
            kind: "primer" as ProvenanceArtifactKind,
            id: "testing",
            path: "primers/testing.md",
            originalContent: "Original pre-disclosure content",
            inContextText,
            blanked: false,
          },
        ],
      });

      expect(record.assembled_artifacts).toHaveLength(1);
      const artifact = record.assembled_artifacts[0];

      // span is non-null
      expect(artifact.char_span).not.toBeNull();
      const [start, end] = artifact.char_span!;

      // slice(start, end) === inContextText is the core correctness invariant
      expect(finalPreloadPrompt.slice(start, end)).toBe(inContextText);
      expect(end - start).toBe(inContextText.length);
    });

    it("content_hash is from originalContent, not from inContextText", () => {
      const originalContent = "Original pre-disclosure wording";
      const inContextText = "Different post-disclosure text";
      const finalPreloadPrompt = `Prefix ${inContextText} suffix`;

      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt,
        skills: [
          {
            kind: "rule" as ProvenanceArtifactKind,
            id: "errors-are-values",
            path: "rules/errors-are-values.md",
            originalContent,
            inContextText,
            blanked: false,
          },
        ],
      });

      const artifact = record.assembled_artifacts[0];
      expect(artifact.content_hash).toBe(hashContent(originalContent));
      // Explicitly NOT the hash of inContextText
      expect(artifact.content_hash).not.toBe(hashContent(inContextText));
    });

    it("does not set source or sidecar_path for non-blanked artifacts", () => {
      const inContextText = "Rule content here";
      const finalPreloadPrompt = inContextText;

      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt,
        skills: [
          {
            kind: "rule" as ProvenanceArtifactKind,
            id: "deep-modules",
            path: "rules/deep-modules.md",
            originalContent: "Rule content here",
            inContextText,
            blanked: false,
          },
        ],
      });

      const artifact = record.assembled_artifacts[0];
      expect(artifact.source).toBeUndefined();
      expect(artifact.sidecar_path).toBeUndefined();
    });
  });

  describe("blanked artifact: sidecar fields", () => {
    it("sets char_span null and sidecar fields for blanked artifacts", () => {
      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt: "Slim summary text only",
        sidecarPath: "/path/to/.canon/artifacts/agent-skills-abc123.json",
        skills: [
          {
            kind: "primer" as ProvenanceArtifactKind,
            id: "mocking-boundaries",
            path: "primers/mocking-boundaries.md",
            originalContent: "Full original primer content before disclosure",
            inContextText: "", // blanked
            blanked: true,
          },
        ],
      });

      const artifact = record.assembled_artifacts[0];
      expect(artifact.char_span).toBeNull();
      expect(artifact.source).toBe("sidecar");
      expect(artifact.sidecar_path).toBe("/path/to/.canon/artifacts/agent-skills-abc123.json");
    });

    it("content_hash for blanked artifact is from originalContent, NOT from empty string", () => {
      const originalContent = "The real primer content pre-disclosure";
      const emptyHash = hashContent("");

      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt: "Slim summary",
        sidecarPath: "/path/to/sidecar.json",
        skills: [
          {
            kind: "primer" as ProvenanceArtifactKind,
            id: "testing",
            path: "primers/testing.md",
            originalContent,
            inContextText: "",
            blanked: true,
          },
        ],
      });

      const artifact = record.assembled_artifacts[0];
      // Must equal hash of original, not hash of ""
      expect(artifact.content_hash).toBe(hashContent(originalContent));
      expect(artifact.content_hash).not.toBe(emptyHash);
    });
  });

  describe("defensive: inContextText not found in finalPreloadPrompt", () => {
    it("yields char_span null when indexOf returns -1 (never throws)", () => {
      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt: "Some other text entirely",
        skills: [
          {
            kind: "ref" as ProvenanceArtifactKind,
            id: "principle-loading",
            path: "references/principle-loading.md",
            originalContent: "Ref content",
            inContextText: "Text that does not appear in the prompt",
            blanked: false,
          },
        ],
      });

      const artifact = record.assembled_artifacts[0];
      // Defensive: never throw, yield null
      expect(artifact.char_span).toBeNull();
    });
  });

  describe("empty skills array", () => {
    it("produces assembled_artifacts: [] and never throws", () => {
      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt: "",
        skills: [],
      });

      expect(record.assembled_artifacts).toEqual([]);
      expect(() => buildContextProvenanceRecord({ ...baseInput, skills: [] })).not.toThrow();
    });

    it("sets preload_prompt_hash even for empty prompt", () => {
      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt: "",
        skills: [],
      });

      expect(record.preload_prompt_hash).toBe(hashContent(""));
    });
  });

  describe("preload_prompt_hash", () => {
    it("equals hashContent(finalPreloadPrompt)", () => {
      const finalPreloadPrompt = "Full resolved preload prompt text here";
      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt,
        skills: [],
      });

      expect(record.preload_prompt_hash).toBe(hashContent(finalPreloadPrompt));
    });
  });

  describe("record shape invariants", () => {
    it("record contains NO content/originalContent/inContextText keys", () => {
      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt: "Some prompt text",
        skills: [
          {
            kind: "rule" as ProvenanceArtifactKind,
            id: "errors-are-values",
            path: "rules/errors-are-values.md",
            originalContent: "The original wording",
            inContextText: "Some prompt text",
            blanked: false,
          },
        ],
      });

      // Top-level record
      const recordKeys = Object.keys(record);
      expect(recordKeys).not.toContain("content");
      expect(recordKeys).not.toContain("originalContent");
      expect(recordKeys).not.toContain("inContextText");

      // Each artifact
      for (const artifact of record.assembled_artifacts) {
        const artifactKeys = Object.keys(artifact);
        expect(artifactKeys).not.toContain("content");
        expect(artifactKeys).not.toContain("originalContent");
        expect(artifactKeys).not.toContain("inContextText");
      }
    });

    it("agent_id is null (back-filled later by log_step)", () => {
      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt: "prompt",
        skills: [],
      });

      expect(record.agent_id).toBeNull();
    });

    it("passes through all identifying fields correctly", () => {
      const record = buildContextProvenanceRecord({
        workspace: "my-workspace",
        stepId: "implement",
        agentName: "canon:tester",
        spawnedAt: "2026-06-23T08:00:00.000Z",
        finalPreloadPrompt: "prompt text",
        skills: [],
      });

      expect(record.workspace).toBe("my-workspace");
      expect(record.step_id).toBe("implement");
      expect(record.agent_name).toBe("canon:tester");
      expect(record.spawned_at).toBe("2026-06-23T08:00:00.000Z");
    });

    it("step_id is null when stepId is null (fail-open)", () => {
      const record = buildContextProvenanceRecord({
        ...baseInput,
        stepId: null,
        finalPreloadPrompt: "prompt",
        skills: [],
      });

      expect(record.step_id).toBeNull();
    });
  });

  describe("multiple skills mixed", () => {
    it("handles a mix of blanked and non-blanked skills correctly", () => {
      const finalPreloadPrompt = "Rule: errors-are-values content here. End.";
      const ruleText = "errors-are-values content here";

      const record = buildContextProvenanceRecord({
        ...baseInput,
        finalPreloadPrompt,
        sidecarPath: "/path/to/sidecar.json",
        skills: [
          {
            kind: "rule" as ProvenanceArtifactKind,
            id: "errors-are-values",
            path: "rules/errors-are-values.md",
            originalContent: "Original rule wording",
            inContextText: ruleText,
            blanked: false,
          },
          {
            kind: "primer" as ProvenanceArtifactKind,
            id: "testing",
            path: "primers/testing.md",
            originalContent: "Full testing primer content",
            inContextText: "",
            blanked: true,
          },
        ],
      });

      expect(record.assembled_artifacts).toHaveLength(2);

      const [ruleArtifact, primerArtifact] = record.assembled_artifacts;

      // Rule: non-blanked, span found
      expect(ruleArtifact.char_span).not.toBeNull();
      const [start, end] = ruleArtifact.char_span!;
      expect(finalPreloadPrompt.slice(start, end)).toBe(ruleText);

      // Primer: blanked
      expect(primerArtifact.char_span).toBeNull();
      expect(primerArtifact.source).toBe("sidecar");
      expect(primerArtifact.content_hash).toBe(hashContent("Full testing primer content"));
    });
  });
});

// Type-level checks: ensure exported types are accessible
// These are compile-time checks — if they fail, the build fails
const _typeCheck1: ContextProvenanceRecord = {
  workspace: "w",
  step_id: null,
  agent_name: "a",
  agent_id: null,
  spawned_at: "t",
  assembled_artifacts: [],
  preload_prompt_hash: "h",
};

const _typeCheck2: ContextProvenanceSummary = {
  step_id: null,
  agent_id: null,
  agent_name: "a",
  spawned_at: "t",
  artifact_count: 0,
  artifacts: [],
};

const _typeCheck3: AssembledArtifact = {
  kind: "rule",
  id: "x",
  path: "p",
  content_hash: "h",
  char_span: null,
};
