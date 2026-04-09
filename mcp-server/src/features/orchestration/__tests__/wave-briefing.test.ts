import { describe, expect, it } from "vitest";
import { assembleWaveBriefing, type WaveBriefingInput } from "../services/wave-briefing.ts";

describe("assembleWaveBriefing", () => {
  it("assembles briefing with consultation outputs", () => {
    const input: WaveBriefingInput = {
      consultationOutputs: {
        "advisor-1": {
          section: "Security notes",
          summary: "Sanitise all user input before passing to the template engine.",
        },
      },
      wave: 2,
    };

    const result = assembleWaveBriefing(input);

    expect(result).toContain("## Wave Briefing (from wave 2)");
    expect(result).toContain("### Security notes");
    expect(result).toContain("Sanitise all user input");
  });

  it("produces minimal briefing with header only when no consultation outputs", () => {
    const input: WaveBriefingInput = {
      consultationOutputs: {},
      wave: 1,
    };

    const result = assembleWaveBriefing(input);

    expect(result).toContain("## Wave Briefing (from wave 1)");
    // No body sections
    expect(result).not.toContain("###");
  });

  it("includes consultation output under its declared section heading", () => {
    const input: WaveBriefingInput = {
      consultationOutputs: {
        c1: {
          section: "API decisions",
          summary: "Use REST not GraphQL for this service.",
        },
        c2: {
          section: "Performance notes",
          summary: "Cache query results for 60 seconds.",
        },
      },
      wave: 3,
    };

    const result = assembleWaveBriefing(input);

    expect(result).toContain("### API decisions");
    expect(result).toContain("Use REST not GraphQL");
    expect(result).toContain("### Performance notes");
    expect(result).toContain("Cache query results");
  });

  it("handles empty consultationOutputs — produces briefing header only", () => {
    const input: WaveBriefingInput = {
      consultationOutputs: {},
      wave: 4,
    };

    const result = assembleWaveBriefing(input);

    expect(result).toContain("## Wave Briefing (from wave 4)");
    expect(result).not.toContain("###");
  });

  it("truncates output exceeding ~2000 characters and appends truncation marker", () => {
    // Generate a very long consultation summary well over 2000 chars
    const longSummary = "Architecture decision: ".repeat(100);
    const input: WaveBriefingInput = {
      consultationOutputs: {
        c1: { section: "Architecture", summary: longSummary },
        c2: { section: "Performance", summary: longSummary },
        c3: { section: "Security", summary: longSummary },
      },
      wave: 5,
    };

    const result = assembleWaveBriefing(input);

    expect(result.length).toBeLessThanOrEqual(2000 + "\n\n[Briefing truncated]".length);
    expect(result).toContain("[Briefing truncated]");
  });

  it("preserves pre-escaped \\${...} in consultation output without double-escaping", () => {
    const input: WaveBriefingInput = {
      consultationOutputs: {
        c1: {
          section: "Injection safety",
          summary: "Variable \\${user_input} is safely escaped.",
        },
      },
      wave: 6,
    };

    const result = assembleWaveBriefing(input);

    expect(result).toContain("\\${user_input}");
    expect(result).not.toContain("\\\\${");
  });

  it("omits consultation output that has no section key", () => {
    const input: WaveBriefingInput = {
      consultationOutputs: {
        "no-section": {
          // section is intentionally absent
          summary: "This output has no section heading.",
        },
      },
      wave: 7,
    };

    const result = assembleWaveBriefing(input);

    // The summary text should not appear as a floating section
    expect(result).not.toContain("This output has no section heading.");
  });

  it("does not have summary-parsing sections (newSharedCode, patternsEstablished, gotchas)", () => {
    // These sections were removed when dead summary-parsing logic was cleaned up
    const input: WaveBriefingInput = {
      consultationOutputs: {},
      wave: 8,
    };

    const result = assembleWaveBriefing(input);

    expect(result).not.toContain("### New shared code");
    expect(result).not.toContain("### Patterns established");
    expect(result).not.toContain("### Gotchas");
  });
});
