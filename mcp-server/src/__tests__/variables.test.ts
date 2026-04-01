import { describe, expect, it } from "vitest";
import { buildTemplateInjection, substituteVariables } from "../orchestration/variables.ts";

describe("substituteVariables", () => {
  it("replaces a simple variable", () => {
    expect(substituteVariables("Hello ${name}!", { name: "World" })).toBe("Hello World!");
  });

  it("replaces multiple variables", () => {
    const result = substituteVariables("${greeting}, ${name}!", {
      greeting: "Hi",
      name: "Alice",
    });
    expect(result).toBe("Hi, Alice!");
  });

  it("leaves missing variables unchanged", () => {
    expect(substituteVariables("${known} and ${unknown}", { known: "yes" })).toBe("yes and ${unknown}");
  });

  it("handles nested ${item.field} patterns", () => {
    const result = substituteVariables("Value: ${item.field}", {
      "item.field": "nested-value",
    });
    expect(result).toBe("Value: nested-value");
  });

  it("returns empty string for empty template", () => {
    expect(substituteVariables("", { key: "val" })).toBe("");
  });

  it("returns template unchanged when no variables present", () => {
    expect(substituteVariables("no vars here", { key: "val" })).toBe("no vars here");
  });
});

describe("buildTemplateInjection", () => {
  it("generates instruction for a single template string", () => {
    const result = buildTemplateInjection("review-checklist", "/plugins/canon");
    expect(result).toBe(
      "Use the review-checklist template at `/plugins/canon/templates/review-checklist.md`. Read the template first and follow its structure exactly.",
    );
  });

  it("generates instructions for an array of templates", () => {
    const result = buildTemplateInjection(["design-decision", "test-report"], "/plugins/canon");
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("design-decision");
    expect(lines[0]).toContain("/plugins/canon/templates/design-decision.md");
    expect(lines[1]).toContain("test-report");
    expect(lines[1]).toContain("/plugins/canon/templates/test-report.md");
  });

  it("constructs correct paths from pluginDir", () => {
    const result = buildTemplateInjection("session-context", "/my/dir");
    expect(result).toContain("`/my/dir/templates/session-context.md`");
  });
});
