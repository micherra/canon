import { describe, it, expect } from "vitest";
import { assembleWaveBriefing, WaveBriefingInput } from "../orchestration/wave-briefing.js";

describe("assembleWaveBriefing", () => {
  it("assembles briefing with all sections populated", () => {
    const input: WaveBriefingInput = {
      wave: 2,
      summaries: [
        "created src/utils/formatter.ts with formatDate helper",
        "established a pattern of barrel exports via index.ts",
        "found a gotcha: unexpected empty-string edge case in parser",
      ],
      consultationOutputs: {
        "advisor-1": {
          section: "Security notes",
          summary: "Sanitise all user input before passing to the template engine.",
        },
      },
    };

    const result = assembleWaveBriefing(input);

    expect(result).toContain("## Wave Briefing (from wave 2)");
    expect(result).toContain("### New shared code");
    expect(result).toContain("src/utils/formatter.ts");
    expect(result).toContain("### Patterns established");
    expect(result).toContain("barrel exports");
    expect(result).toContain("### Gotchas");
    expect(result).toContain("unexpected empty-string");
    expect(result).toContain("### Security notes");
    expect(result).toContain("Sanitise all user input");
  });

  it("omits empty sections when no matching lines are found", () => {
    const input: WaveBriefingInput = {
      wave: 1,
      summaries: ["Did some work, everything went smoothly."],
      consultationOutputs: {},
    };

    const result = assembleWaveBriefing(input);

    expect(result).toContain("## Wave Briefing (from wave 1)");
    expect(result).not.toContain("### New shared code");
    expect(result).not.toContain("### Patterns established");
    expect(result).not.toContain("### Gotchas");
  });

  it("includes consultation output under its declared section heading", () => {
    const input: WaveBriefingInput = {
      wave: 3,
      summaries: [],
      consultationOutputs: {
        "c1": {
          section: "API decisions",
          summary: "Use REST not GraphQL for this service.",
        },
        "c2": {
          section: "Performance notes",
          summary: "Cache query results for 60 seconds.",
        },
      },
    };

    const result = assembleWaveBriefing(input);

    expect(result).toContain("### API decisions");
    expect(result).toContain("Use REST not GraphQL");
    expect(result).toContain("### Performance notes");
    expect(result).toContain("Cache query results");
  });

  it("handles empty summaries array — produces minimal briefing with header only", () => {
    const input: WaveBriefingInput = {
      wave: 4,
      summaries: [],
      consultationOutputs: {},
    };

    const result = assembleWaveBriefing(input);

    expect(result).toContain("## Wave Briefing (from wave 4)");
    // No body sections
    expect(result).not.toContain("###");
  });

  it("handles empty consultationOutputs — produces briefing without consultation sections", () => {
    const input: WaveBriefingInput = {
      wave: 5,
      summaries: ["added src/helpers/math.ts with add and multiply"],
      consultationOutputs: {},
    };

    const result = assembleWaveBriefing(input);

    expect(result).toContain("### New shared code");
    expect(result).not.toContain("### API");
    expect(result).not.toContain("### Performance");
  });

  it("truncates output exceeding ~2000 characters and appends truncation marker", () => {
    // Generate a very long summary well over 2000 chars
    const longLine = "created src/shared/very-long-module.ts with exports and helpers — ".repeat(50);
    const input: WaveBriefingInput = {
      wave: 6,
      summaries: [longLine],
      consultationOutputs: {},
    };

    const result = assembleWaveBriefing(input);

    expect(result.length).toBeLessThanOrEqual(2000 + "\n\n[Briefing truncated]".length);
    expect(result).toContain("[Briefing truncated]");
  });

  it("preserves pre-escaped \\${...} in input without double-escaping or stripping", () => {
    // The caller is responsible for escaping. Simulate already-escaped input.
    const input: WaveBriefingInput = {
      wave: 7,
      summaries: ["created src/template.ts — value is \\${foo} not expanded"],
      consultationOutputs: {
        "c1": {
          section: "Injection safety",
          summary: "Variable \\${user_input} is safely escaped.",
        },
      },
    };

    const result = assembleWaveBriefing(input);

    // The escaped pattern must survive unchanged
    expect(result).toContain("\\${foo}");
    expect(result).toContain("\\${user_input}");
    // Must NOT double-escape (i.e., \\\\${...} should not appear)
    expect(result).not.toContain("\\\\${");
  });

  it("omits consultation output that has no section key", () => {
    const input: WaveBriefingInput = {
      wave: 8,
      summaries: [],
      consultationOutputs: {
        "no-section": {
          // section is intentionally absent
          summary: "This output has no section heading.",
        },
      },
    };

    const result = assembleWaveBriefing(input);

    // The summary text should not appear as a floating section
    expect(result).not.toContain("This output has no section heading.");
  });
});
