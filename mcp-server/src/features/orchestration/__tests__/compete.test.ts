import type { SpawnPromptEntry } from "@features/prompt-pipeline/model/types.ts";
import { describe, expect, it } from "vitest";
import {
  buildSynthesizerPrompt,
  type CompeteConfig,
  type CompetitorOutput,
  expandCompetitorPrompts,
} from "../engine/compete.ts";

describe("compete", () => {
  const basePrompt: SpawnPromptEntry = {
    agent: "architect",
    prompt: "Design the authentication system for the app.",
    template_paths: ["/templates/design-document.md"],
  };

  describe("expandCompetitorPrompts", () => {
    it("expands to N prompts with team labels", () => {
      const config: CompeteConfig = { count: 3, strategy: "synthesize" };
      const result = expandCompetitorPrompts(basePrompt, config);

      expect(result).toHaveLength(3);
      expect(result[0].prompt).toContain("Team A");
      expect(result[1].prompt).toContain("Team B");
      expect(result[2].prompt).toContain("Team C");
    });

    it("injects lens into competitor prompts", () => {
      const config: CompeteConfig = {
        count: 3,
        lenses: ["simplicity", "extensibility", "performance"],
        strategy: "synthesize",
      };
      const result = expandCompetitorPrompts(basePrompt, config);

      expect(result[0].prompt).toContain("simplicity");
      expect(result[0].prompt).toContain("Your Lens");
      expect(result[1].prompt).toContain("extensibility");
      expect(result[2].prompt).toContain("performance");
    });

    it("uses generic framing when no lens provided", () => {
      const config: CompeteConfig = { count: 2, strategy: "select" };
      const result = expandCompetitorPrompts(basePrompt, config);

      expect(result[0].prompt).toContain("Your Team");
      expect(result[0].prompt).toContain("best solution you can");
      expect(result[0].prompt).not.toContain("Your Lens");
    });

    it("handles partial lenses (fewer lenses than count)", () => {
      const config: CompeteConfig = {
        count: 3,
        lenses: ["simplicity"],
        strategy: "synthesize",
      };
      const result = expandCompetitorPrompts(basePrompt, config);

      expect(result[0].prompt).toContain("simplicity");
      expect(result[0].prompt).toContain("Your Lens");
      expect(result[1].prompt).toContain("Your Team");
      expect(result[2].prompt).toContain("Your Team");
    });

    it("preserves base prompt content in all competitors", () => {
      const config: CompeteConfig = { count: 2, strategy: "synthesize" };
      const result = expandCompetitorPrompts(basePrompt, config);

      for (const p of result) {
        expect(p.prompt).toContain("Design the authentication system");
        expect(p.agent).toBe("architect");
        expect(p.template_paths).toEqual(["/templates/design-document.md"]);
      }
    });

    it("assigns correct indices", () => {
      const config: CompeteConfig = { count: 3, strategy: "synthesize" };
      const result = expandCompetitorPrompts(basePrompt, config);

      expect(result.map((r) => r.index)).toEqual([0, 1, 2]);
    });
  });

  describe("buildSynthesizerPrompt", () => {
    const outputs: CompetitorOutput[] = [
      { content: "Use JWT with minimal middleware.", index: 0, lens: "simplicity" },
      { content: "Use OAuth2 with plugin architecture.", index: 1, lens: "extensibility" },
      { content: "Use session cookies with Redis cache.", index: 2, lens: "performance" },
    ];

    it("builds synthesis prompt with all outputs", () => {
      const prompt = buildSynthesizerPrompt("Design auth system", outputs, "synthesize");

      expect(prompt).toContain("Synthesis Task");
      expect(prompt).toContain("Design auth system");
      expect(prompt).toContain("Team 1 (lens: simplicity)");
      expect(prompt).toContain("Team 2 (lens: extensibility)");
      expect(prompt).toContain("Team 3 (lens: performance)");
      expect(prompt).toContain("Use JWT with minimal middleware.");
      expect(prompt).toContain("NOT picking a winner");
    });

    it("builds selection prompt in select mode", () => {
      const prompt = buildSynthesizerPrompt("Design auth system", outputs, "select");

      expect(prompt).toContain("Selection Task");
      expect(prompt).toContain("Pick the single best solution");
      expect(prompt).not.toContain("NOT picking a winner");
    });

    it("handles outputs without lenses", () => {
      const noLensOutputs: CompetitorOutput[] = [
        { content: "Approach A", index: 0 },
        { content: "Approach B", index: 1 },
      ];
      const prompt = buildSynthesizerPrompt("Brief", noLensOutputs, "synthesize");

      expect(prompt).toContain("Team 1");
      expect(prompt).toContain("Team 2");
      expect(prompt).not.toContain("lens:");
    });
  });
});
