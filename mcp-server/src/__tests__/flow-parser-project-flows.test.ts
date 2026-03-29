/**
 * Tests for two-tier flow/fragment resolution — project directory first, plugin directory fallback.
 *
 * These tests create temporary directories with project-level flow files to verify that
 * loadAndResolveFlow and loadFragment correctly implement the two-tier lookup pattern.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadAndResolveFlow,
  loadFragment,
  resolveFragments,
} from "../orchestration/flow-parser.ts";
import type { FragmentDefinition } from "../orchestration/flow-schema.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// pluginDir points to the project root (canon/), which contains flows/ and flows/fragments/
const pluginDir = resolve(__dirname, "../../..");

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PROJECT_FLOW_CONTENT = `---
name: my-project-flow
description: A project-specific flow

states:
  research:
    type: single
    agent: canon-researcher
    transitions:
      done: done

  done:
    type: terminal
---

## Spawn Instructions

### research
Research the topic.
`;

/** A project-level flow that overrides the plugin-level "feature" flow */
const PROJECT_OVERRIDE_FLOW = `---
name: feature
description: Project-overridden feature flow

states:
  build:
    type: single
    agent: custom-implementor
    transitions:
      done: done

  done:
    type: terminal
---

## Spawn Instructions

### build
Build the feature with project-specific instructions.
`;

const PROJECT_FRAGMENT_CONTENT = `---
fragment: my-plugin-frag
entry: frag-work
states:
  frag-work:
    type: single
    agent: project-agent
    transitions:
      done: done
---

## Spawn Instructions

### frag-work
Do project-level work.
`;

/** A consultation fragment with skip_when */
const TARGETED_RESEARCH_FRAGMENT = `---
fragment: targeted-research
type: consultation
description: Targeted research consultation
agent: canon-researcher
role: researcher
section: Research Findings
skip_when: no_open_questions
---

## Spawn Instructions

### targeted-research
Research open questions from the pattern-check.
`;

/** A project flow that uses the targeted-research fragment */
const EPIC_FLOW_WITH_TARGETED_RESEARCH = `---
name: test-epic
description: Test epic flow with consultation fragment

entry: research

states:
  research:
    type: single
    agent: canon-researcher
    transitions:
      done: done

  done:
    type: terminal

includes:
  - fragment: targeted-research
---

## Spawn Instructions

### research
Research the topic.
`;

// ---------------------------------------------------------------------------
// Temporary directory setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let projectDir: string;

beforeAll(async () => {
  tmpDir = join(tmpdir(), `canon-test-project-flows-${Date.now()}`);
  projectDir = tmpDir;

  // Create project directory structure
  const projectFlowsDir = join(projectDir, ".canon", "flows");
  const projectFragmentsDir = join(projectFlowsDir, "fragments");
  await mkdir(projectFlowsDir, { recursive: true });
  await mkdir(projectFragmentsDir, { recursive: true });

  // Write project-level flow files
  await writeFile(join(projectFlowsDir, "my-project-flow.md"), PROJECT_FLOW_CONTENT, "utf-8");
  await writeFile(join(projectFlowsDir, "feature.md"), PROJECT_OVERRIDE_FLOW, "utf-8");
  await writeFile(join(projectFlowsDir, "test-epic.md"), EPIC_FLOW_WITH_TARGETED_RESEARCH, "utf-8");

  // Write project-level fragment files
  await writeFile(join(projectFragmentsDir, "my-plugin-frag.md"), PROJECT_FRAGMENT_CONTENT, "utf-8");
  await writeFile(join(projectFragmentsDir, "targeted-research.md"), TARGETED_RESEARCH_FRAGMENT, "utf-8");
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Plugin-only resolution (no projectDir) — backward compat
// ---------------------------------------------------------------------------

describe("loadAndResolveFlow — plugin-only (no projectDir)", () => {
  it("loads the feature flow from plugin dir without projectDir", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "feature");

    expect(flow.name).toBe("feature");
    expect(flow.entry).toBeDefined();
    expect(errors).toEqual([]);
  });

  it("loads review-only from plugin dir (regression check)", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "review-only");

    expect(flow.name).toBe("review-only");
    expect(flow.entry).toBe("review");
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Project-level flow resolution
// ---------------------------------------------------------------------------

describe("loadAndResolveFlow — project-level resolution", () => {
  it("loads a flow from project .canon/flows/ when projectDir is provided", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "my-project-flow", projectDir);

    expect(flow.name).toBe("my-project-flow");
    expect(flow.entry).toBe("research");
    expect(flow.states["research"]).toBeDefined();
    expect(flow.states["research"].agent).toBe("canon-researcher");
    expect(errors).toEqual([]);
  });

  it("project-level flow overrides plugin-level flow of the same name", async () => {
    // The project has a "feature.md" that overrides the plugin's "feature.md"
    const { flow: projectFlow } = await loadAndResolveFlow(pluginDir, "feature", projectDir);
    const { flow: pluginFlow } = await loadAndResolveFlow(pluginDir, "feature");

    // Project flow has "build" state with custom-implementor
    expect(projectFlow.states["build"]).toBeDefined();
    expect(projectFlow.states["build"].agent).toBe("custom-implementor");

    // Plugin flow uses a different structure (no "build" state with custom-implementor)
    // The plugin feature flow uses "design", "implement", etc.
    expect(pluginFlow.states["build"]).toBeUndefined();
  });

  it("falls back to plugin flow when flow not in project dir", async () => {
    // review-only is only in plugin dir; project dir does not have it
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "review-only", projectDir);

    expect(flow.name).toBe("review-only");
    expect(flow.entry).toBe("review");
    expect(errors).toEqual([]);
  });

  it("throws informative error when flow not found in either location", async () => {
    await expect(
      loadAndResolveFlow(pluginDir, "nonexistent-flow-xyz", projectDir),
    ).rejects.toThrow(/nonexistent-flow-xyz/);
  });
});

// ---------------------------------------------------------------------------
// Fragment resolution — project dir first
// ---------------------------------------------------------------------------

describe("loadFragment — project dir first", () => {
  it("loads fragment from project dir when projectDir provided and fragment exists there", async () => {
    const { definition } = await loadFragment(pluginDir, "my-plugin-frag", projectDir);

    // The project-level fragment has agent "project-agent"
    expect(definition.fragment).toBe("my-plugin-frag");
    expect(definition.states?.["frag-work"]?.agent).toBe("project-agent");
  });

  it("loads fragment from plugin dir when projectDir provided but fragment not in project dir", async () => {
    // "implement-verify" only exists in plugin dir
    const { definition } = await loadFragment(pluginDir, "implement-verify", projectDir);

    expect(definition.fragment).toBe("implement-verify");
  });

  it("loads fragment from plugin dir when no projectDir provided (backward compat)", async () => {
    const { definition } = await loadFragment(pluginDir, "implement-verify");

    expect(definition.fragment).toBe("implement-verify");
  });

  it("loads targeted-research fragment with skip_when from project dir", async () => {
    const { definition } = await loadFragment(pluginDir, "targeted-research", projectDir);

    expect(definition.fragment).toBe("targeted-research");
    expect(definition.type).toBe("consultation");
    expect(definition.skip_when).toBe("no_open_questions");
  });
});

// ---------------------------------------------------------------------------
// Mixed resolution — project-level fragment referenced in project-level flow
// ---------------------------------------------------------------------------

describe("loadAndResolveFlow — mixed project/plugin fragment resolution", () => {
  it("project-level flow can reference project-level consultation fragment", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "test-epic", projectDir);

    expect(flow.name).toBe("test-epic");
    expect(flow.entry).toBe("research");
    expect(flow.states["research"]).toBeDefined();

    // The targeted-research fragment should be resolved as a consultation
    expect(flow.consultations).toBeDefined();
    expect(flow.consultations?.["targeted-research"]).toBeDefined();
    expect(errors).toEqual([]);
  });

  it("targeted-research consultation has skip_when propagated from fragment definition", async () => {
    const { flow } = await loadAndResolveFlow(pluginDir, "test-epic", projectDir);

    const consultation = flow.consultations?.["targeted-research"];
    expect(consultation).toBeDefined();
    // skip_when should be propagated from the fragment definition
    // Note: This field is added to ConsultationFragmentSchema by epic-01
    expect((consultation as Record<string, unknown>)["skip_when"]).toBe("no_open_questions");
  });
});

// ---------------------------------------------------------------------------
// resolveFragments — consultation skip_when propagation
// ---------------------------------------------------------------------------

describe("resolveFragments — consultation skip_when propagation", () => {
  it("propagates skip_when from fragment definition to resolved consultation", () => {
    const baseFlow = {
      name: "test",
      description: "test",
      states: {
        start: {
          type: "single" as const,
          agent: "a",
          transitions: { done: "done" },
        },
        done: { type: "terminal" as const },
      },
    };

    const consultationFragment: FragmentDefinition = {
      fragment: "my-consult",
      type: "consultation",
      agent: "canon-researcher",
      role: "researcher",
      section: "Research Findings",
      skip_when: "no_open_questions",
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: consultationFragment, spawnInstructions: {} }],
      [{ fragment: "my-consult" }],
    );

    const consultation = result.consultations["my-consult"];
    expect(consultation).toBeDefined();
    expect(consultation.agent).toBe("canon-researcher");
    // skip_when should be propagated via spread
    expect((consultation as Record<string, unknown>)["skip_when"]).toBe("no_open_questions");
  });

  it("consultation without skip_when does not get skip_when field set", () => {
    const baseFlow = {
      name: "test",
      description: "test",
      states: {
        start: {
          type: "single" as const,
          agent: "a",
          transitions: { done: "done" },
        },
        done: { type: "terminal" as const },
      },
    };

    const consultationFragment: FragmentDefinition = {
      fragment: "plain-consult",
      type: "consultation",
      agent: "canon-reviewer",
      role: "reviewer",
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: consultationFragment, spawnInstructions: {} }],
      [{ fragment: "plain-consult" }],
    );

    const consultation = result.consultations["plain-consult"];
    expect(consultation).toBeDefined();
    expect((consultation as Record<string, unknown>)["skip_when"]).toBeUndefined();
  });
});
