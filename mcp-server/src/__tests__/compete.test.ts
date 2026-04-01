import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSynthesizerPrompt,
  type CompeteConfig,
  type CompetitorOutput,
  expandCompetitorPrompts,
} from "../orchestration/compete.ts";
import type { SpawnPromptEntry } from "../tools/get-spawn-prompt.ts";

// ---------------------------------------------------------------------------
// Mocks for getSpawnPrompt compete path tests
// ---------------------------------------------------------------------------

vi.mock("../orchestration/wave-briefing.ts", () => ({
  readWaveGuidance: vi.fn().mockResolvedValue(""),
  assembleWaveBriefing: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../orchestration/diff-cluster.ts", () => ({
  clusterDiff: vi.fn(),
}));

describe("compete", () => {
  const basePrompt: SpawnPromptEntry = {
    agent: "canon-architect",
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
        strategy: "synthesize",
        lenses: ["simplicity", "extensibility", "performance"],
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
        strategy: "synthesize",
        lenses: ["simplicity"],
      };
      const result = expandCompetitorPrompts(basePrompt, config);

      expect(result[0].prompt).toContain("simplicity");
      expect(result[0].prompt).toContain("Your Lens");
      expect(result[1].prompt).toContain("Your Team"); // no lens
      expect(result[2].prompt).toContain("Your Team"); // no lens
    });

    it("preserves base prompt content in all competitors", () => {
      const config: CompeteConfig = { count: 2, strategy: "synthesize" };
      const result = expandCompetitorPrompts(basePrompt, config);

      for (const p of result) {
        expect(p.prompt).toContain("Design the authentication system");
        expect(p.agent).toBe("canon-architect");
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
      { index: 0, lens: "simplicity", content: "Use JWT with minimal middleware." },
      { index: 1, lens: "extensibility", content: "Use OAuth2 with plugin architecture." },
      { index: 2, lens: "performance", content: "Use session cookies with Redis cache." },
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
        { index: 0, content: "Approach A" },
        { index: 1, content: "Approach B" },
      ];
      const prompt = buildSynthesizerPrompt("Brief", noLensOutputs, "synthesize");

      expect(prompt).toContain("Team 1");
      expect(prompt).toContain("Team 2");
      expect(prompt).not.toContain("lens:");
    });
  });
});

// ---------------------------------------------------------------------------
// resolveCompeteConfig("auto") and compete path through get-spawn-prompt
// ---------------------------------------------------------------------------

import { clusterDiff } from "../orchestration/diff-cluster.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsp-compete-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeCompeteFlow(competeValue: "auto" | { count: number; strategy: "synthesize" | "select"; lenses?: string[] } = "auto"): ResolvedFlow {
  return {
    name: "compete-flow",
    description: "Test compete flow",
    entry: "design",
    states: {
      design: {
        type: "single",
        agent: "canon-architect",
        compete: competeValue,
        transitions: { done: "ship" },
      },
      ship: { type: "terminal" },
    },
    spawn_instructions: {
      design: "Design the system for ${task}.",
    },
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

describe("resolveCompeteConfig auto + compete path through getSpawnPrompt", () => {
  it("resolveCompeteConfig('auto') expands to 3 competitors with synthesize strategy", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    const result = await getSpawnPrompt({
      workspace,
      state_id: "design",
      flow: makeCompeteFlow("auto"),
      variables: { task: "auth system" },
    });

    // auto → 3 competitors
    expect(result.prompts).toHaveLength(3);
    expect(result.fanned_out).toBe(true);
    expect(result.prompts[0].prompt).toContain("Team A");
    expect(result.prompts[1].prompt).toContain("Team B");
    expect(result.prompts[2].prompt).toContain("Team C");
  });

  it("compete path preserves agent type from state", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    const result = await getSpawnPrompt({
      workspace,
      state_id: "design",
      flow: makeCompeteFlow("auto"),
      variables: { task: "auth system" },
    });

    for (const p of result.prompts) {
      expect(p.agent).toBe("canon-architect");
    }
  });

  it("compete path with explicit count and lenses fans out correctly", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow = makeCompeteFlow({ count: 2, strategy: "select", lenses: ["simplicity", "performance"] });
    const result = await getSpawnPrompt({
      workspace,
      state_id: "design",
      flow,
      variables: { task: "auth system" },
    });

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].prompt).toContain("simplicity");
    expect(result.prompts[1].prompt).toContain("performance");
  });

  it("compete with non-single state type produces a warning", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow: ResolvedFlow = {
      name: "wave-flow",
      description: "Test",
      entry: "build",
      states: {
        build: {
          type: "wave",
          agent: "canon-implementor",
          compete: "auto" as const, // non-single with compete
          transitions: { done: "done_state" },
        },
        done_state: { type: "terminal" },
      },
      spawn_instructions: {
        build: "Implement ${task}.",
      },
    };

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: { task: "feature" },
      items: [{ name: "task-1" }],
    });

    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes("compete"))).toBe(true);
  });
});
