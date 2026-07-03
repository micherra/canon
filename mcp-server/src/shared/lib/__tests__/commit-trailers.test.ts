/**
 * commit-trailers.test.ts — Tests for formatCommitTrailers and buildCommitMessage
 *
 * Tests cover:
 * - formatCommitTrailers with all fields produces correct 4-line output
 * - formatCommitTrailers without taskId produces 3-line output (no Canon-Task)
 * - formatCommitTrailers with empty required field returns empty string
 * - buildCommitMessage with body produces subject + body + trailers + Co-Authored-By
 * - buildCommitMessage with empty body omits body section
 * - Trailer lines match Key: value format (regex validation)
 */

import { describe, expect, it } from "vitest";
import { buildCommitMessage, formatCommitTrailers } from "../commit-trailers.ts";

// formatCommitTrailers

describe("formatCommitTrailers — all fields", () => {
  it("produces 4-line output when taskId is provided", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      taskId: "task-01",
      workflow: "my-slug",
    });
    const lines = result.split("\n");
    expect(lines).toHaveLength(4);
  });

  it("includes Canon-Workflow line", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      taskId: "task-01",
      workflow: "my-slug",
    });
    expect(result).toContain("Canon-Workflow: my-slug");
  });

  it("includes Canon-Agent line", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      taskId: "task-01",
      workflow: "my-slug",
    });
    expect(result).toContain("Canon-Agent: implementor");
  });

  it("includes Canon-State line", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      taskId: "task-01",
      workflow: "my-slug",
    });
    expect(result).toContain("Canon-State: implement");
  });

  it("includes Canon-Task line when taskId provided", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      taskId: "task-01",
      workflow: "my-slug",
    });
    expect(result).toContain("Canon-Task: task-01");
  });

  it("returns correct 4-line block in order", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      taskId: "task-01",
      workflow: "my-slug",
    });
    expect(result).toBe(
      "Canon-Workflow: my-slug\nCanon-Agent: implementor\nCanon-State: implement\nCanon-Task: task-01",
    );
  });
});

describe("formatCommitTrailers — without taskId", () => {
  it("produces 3-line output when taskId is omitted", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
  });

  it("does not include Canon-Task line", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).not.toContain("Canon-Task");
  });

  it("returns correct 3-line block", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).toBe(
      "Canon-Workflow: my-slug\nCanon-Agent: implementor\nCanon-State: implement",
    );
  });
});

describe("formatCommitTrailers — evolutionId", () => {
  it("appends Canon-Evolution after Canon-Task when both present", () => {
    const result = formatCommitTrailers({
      agent: "engineer",
      evolutionId: "evolve-20260702-01",
      state: "implement",
      taskId: "task-01",
      workflow: "my-slug",
    });
    expect(result).toBe(
      "Canon-Workflow: my-slug\nCanon-Agent: engineer\nCanon-State: implement\nCanon-Task: task-01\nCanon-Evolution: evolve-20260702-01",
    );
  });

  it("appends Canon-Evolution after Canon-State when no taskId", () => {
    const result = formatCommitTrailers({
      agent: "engineer",
      evolutionId: "evolve-20260702-01",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).toBe(
      "Canon-Workflow: my-slug\nCanon-Agent: engineer\nCanon-State: implement\nCanon-Evolution: evolve-20260702-01",
    );
  });

  it("omits Canon-Evolution when evolutionId absent (backward compatible)", () => {
    const result = formatCommitTrailers({
      agent: "engineer",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).not.toContain("Canon-Evolution");
  });

  it("omits Canon-Evolution when evolutionId is empty string", () => {
    const result = formatCommitTrailers({
      agent: "engineer",
      evolutionId: "",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).not.toContain("Canon-Evolution");
  });
});

describe("formatCommitTrailers — empty required fields", () => {
  it("returns empty string when workflow is empty", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      workflow: "",
    });
    expect(result).toBe("");
  });

  it("returns empty string when agent is empty", () => {
    const result = formatCommitTrailers({
      agent: "",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).toBe("");
  });

  it("returns empty string when state is empty", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "",
      workflow: "my-slug",
    });
    expect(result).toBe("");
  });
});

describe("formatCommitTrailers — trailer line format", () => {
  it("all lines match Key: value format", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      taskId: "task-01",
      workflow: "my-slug",
    });
    const trailerLinePattern = /^[A-Za-z-]+: .+$/;
    for (const line of result.split("\n")) {
      expect(line).toMatch(trailerLinePattern);
    }
  });

  it("has no trailing newline", () => {
    const result = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result.endsWith("\n")).toBe(false);
  });
});

// buildCommitMessage

describe("buildCommitMessage — with body", () => {
  it("includes subject as first line", () => {
    const result = buildCommitMessage("feat: add parser", "Body text here.", {
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result.startsWith("feat: add parser")).toBe(true);
  });

  it("includes body after blank line", () => {
    const result = buildCommitMessage("feat: add parser", "Body text here.", {
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).toContain("\n\nBody text here.");
  });

  it("includes trailers after body", () => {
    const result = buildCommitMessage("feat: add parser", "Body text here.", {
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).toContain("Canon-Workflow: my-slug");
    expect(result).toContain("Canon-Agent: implementor");
    expect(result).toContain("Canon-State: implement");
  });

  it("includes Co-Authored-By line after trailers", () => {
    const result = buildCommitMessage("feat: add parser", "Body text here.", {
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).toContain("Co-Authored-By:");
  });

  it("assembles full structure: subject + blank + body + blank + trailers + Co-Authored-By", () => {
    const result = buildCommitMessage("feat: add parser", "Body text here.", {
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    const trailers = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).toBe(
      `feat: add parser\n\nBody text here.\n\n${trailers}\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`,
    );
  });
});

describe("buildCommitMessage — with empty body", () => {
  it("omits body section when body is empty string", () => {
    const result = buildCommitMessage("feat: add parser", "", {
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    // Should not have triple newline (which would indicate empty body section)
    expect(result).not.toContain("\n\n\n");
  });

  it("includes subject and trailers separated by blank line", () => {
    const result = buildCommitMessage("feat: add parser", "", {
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    const trailers = formatCommitTrailers({
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).toBe(
      `feat: add parser\n\n${trailers}\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`,
    );
  });

  it("still includes Co-Authored-By when body is empty", () => {
    const result = buildCommitMessage("feat: add parser", "", {
      agent: "implementor",
      state: "implement",
      workflow: "my-slug",
    });
    expect(result).toContain("Co-Authored-By:");
  });
});

describe("buildCommitMessage — with taskId in trailers", () => {
  it("includes Canon-Task when taskId is in trailer opts", () => {
    const result = buildCommitMessage("feat: add parser", "Body.", {
      agent: "implementor",
      state: "implement",
      taskId: "task-01",
      workflow: "my-slug",
    });
    expect(result).toContain("Canon-Task: task-01");
  });
});
