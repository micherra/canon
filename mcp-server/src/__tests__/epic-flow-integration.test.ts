/**
 * Integration tests for the epic flow end-to-end pipeline.
 *
 * Covers:
 * - epic.md loading end-to-end through the two-tier resolver
 * - consultation skip_when propagation in context of the real epic.md
 * - no_gate_progress + no_open_questions runtime paths via normalizeStatus and evaluateSkipWhen
 * - Schema validation gaps (StuckWhenSchema, GateProgressHistoryEntrySchema, ConsultationFragmentSchema.skip_when)
 * - epic_complete status routing through normalizeStatus
 * - Error message listing both project and plugin flows
 * - loadFlow() with projectDir parameter (load-flow.ts → flow-parser.ts cross-task boundary)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import { loadFlow } from "../tools/load-flow.ts";
import { normalizeStatus } from "../orchestration/transitions.ts";
import { evaluateSkipWhen } from "../orchestration/skip-when.ts";
import type { Board } from "../orchestration/flow-schema.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// pluginDir must point to a directory that has flows/fragments/ with all standard fragments.
// The plugin cache has all fragments (test-fix-loop.md, targeted-research.md, etc.).
// The project root (canon/) only has a subset in flows/fragments/.
// See: CLAUDE.md memory — plugin cache at /Users/michelle/.claude/plugins/cache/canon-marketplace/canon/0.1.0/
// Note: pluginDir is for the standard fragment library; tests that don't load epic.md can use the project root.
const pluginCacheDir = "/Users/michelle/.claude/plugins/cache/canon-marketplace/canon/0.1.0";

// projectDir has .canon/flows/epic.md and .canon/flows/fragments/targeted-research.md
const canonProjectDir = resolve(__dirname, "../../..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBoard(overrides?: Partial<Board>): Board {
  return {
    flow: "epic",
    task: "test task",
    entry: "research",
    current_state: "research",
    base_commit: "abc1234",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Temporary directory for error-message tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = join(tmpdir(), `canon-epic-integration-${Date.now()}`);
  const projectFlowsDir = join(tmpDir, ".canon", "flows");
  await mkdir(projectFlowsDir, { recursive: true });

  // Write a project-level flow so it appears in the available list
  await writeFile(
    join(projectFlowsDir, "project-only-flow.md"),
    `---
name: project-only-flow
description: A project-only flow
entry: start
states:
  start:
    type: terminal
---
`,
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// epic_complete status routing — normalizeStatus (declared gap from epic-01)
// ---------------------------------------------------------------------------

describe("normalizeStatus — epic_complete", () => {
  it("normalizes EPIC_COMPLETE to epic_complete (lowercase identity)", () => {
    expect(normalizeStatus("EPIC_COMPLETE")).toBe("epic_complete");
  });

  it("normalizes epic_complete (already lowercase) to epic_complete", () => {
    expect(normalizeStatus("epic_complete")).toBe("epic_complete");
  });

  it("EPIC_COMPLETE does not collapse to 'done' — it maps to its own alias", () => {
    // STATUS_ALIASES maps epic_complete → epic_complete (not done)
    // so it stays as the signal for the epic_complete transition
    const result = normalizeStatus("EPIC_COMPLETE");
    expect(result).not.toBe("done");
    expect(result).toBe("epic_complete");
  });
});

// ---------------------------------------------------------------------------
// Schema validation — StuckWhenSchema (gap: SkipWhenSchema tested but not StuckWhenSchema)
// ---------------------------------------------------------------------------

describe("StuckWhenSchema — no_gate_progress", () => {
  it("accepts no_gate_progress as a valid value", async () => {
    const { StuckWhenSchema } = await import("../orchestration/flow-schema.ts");
    expect(() => StuckWhenSchema.parse("no_gate_progress")).not.toThrow();
    expect(StuckWhenSchema.parse("no_gate_progress")).toBe("no_gate_progress");
  });

  it("still accepts pre-existing stuck_when values", async () => {
    const { StuckWhenSchema } = await import("../orchestration/flow-schema.ts");
    expect(() => StuckWhenSchema.parse("same_violations")).not.toThrow();
    expect(() => StuckWhenSchema.parse("same_file_test")).not.toThrow();
    expect(() => StuckWhenSchema.parse("same_status")).not.toThrow();
    expect(() => StuckWhenSchema.parse("no_progress")).not.toThrow();
  });

  it("rejects unknown stuck_when values", async () => {
    const { StuckWhenSchema } = await import("../orchestration/flow-schema.ts");
    expect(() => StuckWhenSchema.parse("unknown_stuck_value")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema validation — GateProgressHistoryEntrySchema.parse() (declared gap: only indirect coverage)
// ---------------------------------------------------------------------------

describe("GateProgressHistoryEntrySchema — direct parse tests", () => {
  it("parses a valid gate progress history entry with hash and passed: true", async () => {
    const { GateProgressHistoryEntrySchema } = await import("../orchestration/flow-schema.ts");
    const result = GateProgressHistoryEntrySchema.parse({
      gate_output_hash: "abc123",
      passed: true,
    });
    expect(result.gate_output_hash).toBe("abc123");
    expect(result.passed).toBe(true);
  });

  it("parses a valid gate progress history entry with passed: false", async () => {
    const { GateProgressHistoryEntrySchema } = await import("../orchestration/flow-schema.ts");
    const result = GateProgressHistoryEntrySchema.parse({
      gate_output_hash: "deadbeef",
      passed: false,
    });
    expect(result.gate_output_hash).toBe("deadbeef");
    expect(result.passed).toBe(false);
  });

  it("rejects entry missing gate_output_hash", async () => {
    const { GateProgressHistoryEntrySchema } = await import("../orchestration/flow-schema.ts");
    expect(() => GateProgressHistoryEntrySchema.parse({ passed: true })).toThrow();
  });

  it("rejects entry missing passed field", async () => {
    const { GateProgressHistoryEntrySchema } = await import("../orchestration/flow-schema.ts");
    expect(() => GateProgressHistoryEntrySchema.parse({ gate_output_hash: "abc" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema validation — ConsultationFragmentSchema.skip_when (declared gap from epic-01)
// ---------------------------------------------------------------------------

describe("ConsultationFragmentSchema — skip_when field", () => {
  it("accepts a consultation fragment with skip_when: no_open_questions", async () => {
    const { ConsultationFragmentSchema } = await import("../orchestration/flow-schema.ts");
    const result = ConsultationFragmentSchema.parse({
      fragment: "targeted-research",
      agent: "canon-researcher",
      role: "targeted-research",
      skip_when: "no_open_questions",
    });
    expect(result.skip_when).toBe("no_open_questions");
  });

  it("accepts a consultation fragment without skip_when (backward compat)", async () => {
    const { ConsultationFragmentSchema } = await import("../orchestration/flow-schema.ts");
    const result = ConsultationFragmentSchema.parse({
      fragment: "plan-review",
      agent: "canon-reviewer",
      role: "reviewer",
    });
    expect(result.skip_when).toBeUndefined();
  });

  it("accepts a consultation fragment with an arbitrary skip_when string value", async () => {
    // ConsultationFragmentSchema uses z.string().optional() — any string value is valid
    const { ConsultationFragmentSchema } = await import("../orchestration/flow-schema.ts");
    const result = ConsultationFragmentSchema.parse({
      fragment: "some-fragment",
      agent: "some-agent",
      role: "some-role",
      skip_when: "no_fix_requested",
    });
    expect(result.skip_when).toBe("no_fix_requested");
  });
});

// ---------------------------------------------------------------------------
// Schema validation — FragmentDefinitionSchema.skip_when (declared gap from epic-01)
// ---------------------------------------------------------------------------

describe("FragmentDefinitionSchema — skip_when field", () => {
  it("accepts a consultation fragment definition with skip_when", async () => {
    const { FragmentDefinitionSchema } = await import("../orchestration/flow-schema.ts");
    const result = FragmentDefinitionSchema.parse({
      fragment: "targeted-research",
      type: "consultation",
      agent: "canon-researcher",
      role: "targeted-research",
      section: "Research Findings",
      skip_when: "no_open_questions",
    });
    expect(result.skip_when).toBe("no_open_questions");
  });

  it("accepts a fragment definition without skip_when (backward compat)", async () => {
    const { FragmentDefinitionSchema } = await import("../orchestration/flow-schema.ts");
    const result = FragmentDefinitionSchema.parse({
      fragment: "plan-review",
      type: "consultation",
      agent: "canon-reviewer",
      role: "reviewer",
    });
    expect(result.skip_when).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// epic.md loading end-to-end — two-tier resolver with real .canon/flows/epic.md
// ---------------------------------------------------------------------------

describe("epic.md end-to-end loading through two-tier resolver", () => {
  it("loads epic.md from project .canon/flows/ when canonProjectDir is provided", async () => {
    // The project's .canon/flows/epic.md exists — it should take precedence over any plugin epic.md
    // pluginCacheDir provides the fragment library (test-fix-loop.md, etc.)
    const { flow, errors } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    expect(flow.name).toBe("epic");
    expect(errors).toEqual([]);
  });

  it("epic flow has the correct entry state: research", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);
    expect(flow.entry).toBe("research");
  });

  it("epic flow has all three inline states: research, design, implement", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    expect(flow.states["research"]).toBeDefined();
    expect(flow.states["design"]).toBeDefined();
    expect(flow.states["implement"]).toBeDefined();
  });

  it("epic implement state has stuck_when: no_gate_progress", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    expect(flow.states["implement"].stuck_when).toBe("no_gate_progress");
  });

  it("epic implement state has max_iterations: 10", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    expect(flow.states["implement"].max_iterations).toBe(10);
  });

  it("epic implement state does NOT have max_waves (architecture constraint)", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    // max_waves must not be present — architecture decision epic-06
    expect((flow.states["implement"] as Record<string, unknown>)["max_waves"]).toBeUndefined();
  });

  it("epic implement state has epic_complete transition to ship", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    expect(flow.states["implement"].transitions?.["epic_complete"]).toBe("ship");
  });

  it("epic flow has tier: large", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    expect(flow.tier).toBe("large");
  });

  it("epic flow has consultations resolved from fragment includes", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    // targeted-research is in the between consultations of implement
    expect(flow.consultations).toBeDefined();
    expect(flow.consultations?.["targeted-research"]).toBeDefined();
  });

  it("targeted-research consultation in epic flow has skip_when: no_open_questions", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    const consultation = flow.consultations?.["targeted-research"];
    expect(consultation).toBeDefined();
    expect((consultation as Record<string, unknown>)["skip_when"]).toBe("no_open_questions");
  });

  it("epic flow ship state is present (from ship-done fragment)", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    expect(flow.states["ship"]).toBeDefined();
  });

  it("epic flow research state has type: parallel", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    expect(flow.states["research"].type).toBe("parallel");
  });

  it("epic flow design state has done transition to checkpoint", async () => {
    const { flow } = await loadAndResolveFlow(pluginCacheDir, "epic", canonProjectDir);

    expect(flow.states["design"].transitions?.["done"]).toBe("checkpoint");
  });
});

// ---------------------------------------------------------------------------
// loadFlow() with projectDir — load-flow.ts → flow-parser.ts cross-task integration
// ---------------------------------------------------------------------------

describe("loadFlow() with projectDir parameter (cross-task integration)", () => {
  it("loadFlow with projectDir loads epic.md and returns state_graph", async () => {
    const result = await loadFlow({ flow_name: "epic" }, pluginCacheDir, canonProjectDir);

    expect(result.flow.name).toBe("epic");
    expect(result.errors).toEqual([]);
    expect(result.state_graph).toBeDefined();
    expect(typeof result.state_graph).toBe("object");
  });

  it("loadFlow state_graph for epic includes research → design edge", async () => {
    const result = await loadFlow({ flow_name: "epic" }, pluginCacheDir, canonProjectDir);

    // research state transitions done → design
    const researchEdges = result.state_graph["research"];
    expect(researchEdges).toBeDefined();
    expect(researchEdges).toContain("design");
  });

  it("loadFlow state_graph for epic includes implement → ship edge (epic_complete)", async () => {
    const result = await loadFlow({ flow_name: "epic" }, pluginCacheDir, canonProjectDir);

    const implementEdges = result.state_graph["implement"];
    expect(implementEdges).toBeDefined();
    expect(implementEdges).toContain("ship");
  });
});

// ---------------------------------------------------------------------------
// Error message listing flows from both tiers (declared gap from epic-04)
// ---------------------------------------------------------------------------

describe("loadAndResolveFlow error message — lists flows from both project and plugin dirs", () => {
  it("error message mentions the project flows dir and plugin path when projectDir is given", async () => {
    await expect(
      loadAndResolveFlow(pluginCacheDir, "nonexistent-xyz-flow", tmpDir),
    ).rejects.toThrow(/nonexistent-xyz-flow/);
  });

  it("error message includes the project .canon/flows/ directory path", async () => {
    await expect(
      loadAndResolveFlow(pluginCacheDir, "nonexistent-xyz-flow", tmpDir),
    ).rejects.toThrow(new RegExp(`${tmpDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*\\.canon.*flows`));
  });

  it("error message includes project-level flow names in the available list", async () => {
    await expect(
      loadAndResolveFlow(pluginCacheDir, "nonexistent-xyz-flow", tmpDir),
    ).rejects.toThrow(/project-only-flow/);
  });

  it("error message includes plugin-level flow names in the available list", async () => {
    await expect(
      loadAndResolveFlow(pluginCacheDir, "nonexistent-xyz-flow", tmpDir),
    ).rejects.toThrow(/feature/);
  });
});

// ---------------------------------------------------------------------------
// no_open_questions + no_gate_progress runtime integration
// (verifies the two new values work in the evaluateSkipWhen + isStuck pipeline)
// ---------------------------------------------------------------------------

describe("no_open_questions runtime path via evaluateSkipWhen", () => {
  it("returns skip: false when has_open_questions is true on an epic board", async () => {
    const board = makeBoard({ metadata: { has_open_questions: true } });
    const result = await evaluateSkipWhen("no_open_questions", "/tmp/ws", board);
    expect(result.skip).toBe(false);
  });

  it("returns skip: true when has_open_questions is false on an epic board", async () => {
    const board = makeBoard({ metadata: { has_open_questions: false } });
    const result = await evaluateSkipWhen("no_open_questions", "/tmp/ws", board);
    expect(result.skip).toBe(true);
  });

  it("returns skip: true when has_open_questions is absent (between-wave consultation skipped by default)", async () => {
    const board = makeBoard();
    const result = await evaluateSkipWhen("no_open_questions", "/tmp/ws", board);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("targeted research skipped");
  });
});

describe("no_gate_progress isStuck integration with full history", () => {
  it("isStuck is true when gate produces same hash and keeps failing across three waves (only last two matter)", async () => {
    const { isStuck, buildHistoryEntry } = await import("../orchestration/transitions.ts");

    // Wave 1: hash=h1, failed
    const e1 = buildHistoryEntry("no_gate_progress", { gateOutputHash: "h1", gatePassed: false });
    // Wave 2: hash=h1, still failing (progress: false)
    const e2 = buildHistoryEntry("no_gate_progress", { gateOutputHash: "h1", gatePassed: false });
    // Wave 3: hash=h1, still failing (stuck)
    const e3 = buildHistoryEntry("no_gate_progress", { gateOutputHash: "h1", gatePassed: false });

    // Only the last two entries matter → prev=e2, curr=e3 — same hash + not passed = stuck
    expect(isStuck([e1, e2, e3], "no_gate_progress")).toBe(true);
  });

  it("isStuck is false when gate hash changes on wave 3 (progress made)", async () => {
    const { isStuck, buildHistoryEntry } = await import("../orchestration/transitions.ts");

    const e1 = buildHistoryEntry("no_gate_progress", { gateOutputHash: "h1", gatePassed: false });
    const e2 = buildHistoryEntry("no_gate_progress", { gateOutputHash: "h1", gatePassed: false });
    const e3 = buildHistoryEntry("no_gate_progress", { gateOutputHash: "h2", gatePassed: false });

    expect(isStuck([e1, e2, e3], "no_gate_progress")).toBe(false);
  });

  it("isStuck is false when gate passes on wave 3 (gate now passes — not stuck even if hash same)", async () => {
    const { isStuck, buildHistoryEntry } = await import("../orchestration/transitions.ts");

    const e1 = buildHistoryEntry("no_gate_progress", { gateOutputHash: "h1", gatePassed: false });
    const e2 = buildHistoryEntry("no_gate_progress", { gateOutputHash: "h1", gatePassed: false });
    const e3 = buildHistoryEntry("no_gate_progress", { gateOutputHash: "h1", gatePassed: true });

    expect(isStuck([e1, e2, e3], "no_gate_progress")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — existing boards without new fields must still parse
// ---------------------------------------------------------------------------

describe("BoardSchema backward compatibility with new fields", () => {
  it("BoardSchema.parse succeeds on a minimal board without new fields", async () => {
    const { BoardSchema } = await import("../orchestration/flow-schema.ts");

    const minimalBoard = {
      flow: "feature",
      task: "add dark mode",
      entry: "research",
      current_state: "research",
      base_commit: "abc1234",
      started: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      states: {},
      iterations: {},
      blocked: null,
      concerns: [],
      skipped: [],
    };

    expect(() => BoardSchema.parse(minimalBoard)).not.toThrow();
  });

  it("BoardSchema.parse succeeds on a board with has_open_questions in metadata", async () => {
    const { BoardSchema } = await import("../orchestration/flow-schema.ts");

    const board = {
      flow: "epic",
      task: "large refactor",
      entry: "research",
      current_state: "implement",
      base_commit: "abc1234",
      started: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      states: {},
      iterations: {},
      blocked: null,
      concerns: [],
      skipped: [],
      metadata: { has_open_questions: true },
    };

    expect(() => BoardSchema.parse(board)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// STATUS_KEYWORDS and STATUS_ALIASES contain epic_complete (declared gap from epic-01)
// ---------------------------------------------------------------------------

describe("STATUS_KEYWORDS and STATUS_ALIASES — epic_complete registration", () => {
  it("STATUS_KEYWORDS array contains epic_complete", async () => {
    const { STATUS_KEYWORDS } = await import("../orchestration/flow-schema.ts");
    expect(STATUS_KEYWORDS).toContain("epic_complete");
  });

  it("STATUS_ALIASES maps epic_complete to epic_complete (identity alias)", async () => {
    const { STATUS_ALIASES } = await import("../orchestration/flow-schema.ts");
    expect(STATUS_ALIASES["epic_complete"]).toBe("epic_complete");
  });
});
