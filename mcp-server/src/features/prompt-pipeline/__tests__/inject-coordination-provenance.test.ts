/**
 * Integration tests for inject-coordination.ts — commit provenance injection (step 3.5)
 *
 * Fills the declared Known Gap from provenance-03:
 *   "buildProvenanceSection in inject-coordination.ts: not directly unit tested
 *    (relies on existing inject-coordination tests not covering this new section)"
 *
 * Tests verify:
 * - Provenance section injected when session slug is available
 * - Provenance section contains all required Canon trailer fields
 * - Provenance section is appended after the metrics footer (ordering)
 * - taskId included in trailer block for wave task entries (item with task_id)
 * - taskId absent from trailer block for non-wave entries (item is string or undefined)
 * - Returns empty string (no section) when getSession throws (fail-safe)
 * - Returns empty string when session has no slug (fail-safe)
 * - Each prompt entry gets its own per-entry provenance block (different task_ids)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module imports

vi.mock("@domains/messages/messages.ts", () => ({
  buildMessageInstructions: vi.fn().mockReturnValue("## Wave Coordination\n\nInstructions here"),
}));

vi.mock("../model/tool-profiles.ts", () => ({
  AGENT_TOOL_PROFILES: {
    "canon-implementor": {
      allowed: ["Read", "Edit", "Write"],
      disallowed: [],
    },
  },
  EMPTY_PROFILE: {
    allowed: [],
    disallowed: ["Edit", "Write", "Bash", "NotebookEdit"],
  },
  resolveToolProfile: vi.fn().mockReturnValue({
    disallowed_tools: [],
    permission_mode: "prompt",
    tools: ["Read"],
  }),
}));

// Default: no KG DB
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("@graph/kg-schema.ts", () => ({
  initDatabase: vi.fn(),
}));

vi.mock("@graph/kg-query.ts", () => ({
  computeFileInsightMaps: vi.fn().mockReturnValue({
    cycleMemberPaths: new Map(),
    hubPaths: new Set(),
    layerViolationsByPath: new Map(),
  }),
  KgQuery: vi.fn(),
}));

// getExecutionStore mock — controlled per test via mockReturnValue
vi.mock("@domains/workspaces/execution-store.ts", () => ({
  getExecutionStore: vi.fn(),
}));

vi.mock("@features/orchestration/services/scope-resolver.ts", () => ({
  resolveTaskScope: vi.fn().mockReturnValue([]),
}));

vi.mock("../services/trust-resolver.ts", () => ({
  buildScopeMetrics: vi.fn().mockReturnValue({
    hasCycleFile: false,
    hasHighDegreeFile: false,
    hasHubFile: false,
  }),
  computeTrustLevel: vi.fn().mockReturnValue({ level: "HIGH", reason: "All scope files low-risk" }),
  trustLevelToPermissionMode: vi.fn().mockReturnValue("auto"),
}));

vi.mock("@shared/constants.ts", () => ({
  CANON_DIR: ".canon",
  CANON_FILES: { KNOWLEDGE_DB: "knowledge-graph.db" },
}));

import type { ResolvedFlow, StateDefinition } from "@domains/flows/flow-definition-schemas.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import type { PromptContext, SpawnPromptEntry } from "../model/types.ts";
import { injectCoordination } from "../services/inject-coordination.ts";

/** Build a minimal SpawnPromptEntry. */
function makeEntry(overrides: Partial<SpawnPromptEntry> = {}): SpawnPromptEntry {
  return {
    agent: "canon-implementor",
    prompt: "Do the work",
    template_paths: [],
    ...overrides,
  };
}

/** Build a minimal PromptContext. */
function makeCtx(
  overrides: Partial<PromptContext> & {
    workspace?: string;
    state_id?: string;
    flow?: ResolvedFlow;
    variables?: Record<string, string>;
    role?: string;
    wave?: number;
  } = {},
): PromptContext {
  const { workspace, state_id, flow, variables, role, wave, ...rest } = overrides;
  return {
    basePrompt: "Do the thing",
    input: {
      flow:
        flow ??
        ({
          description: "Test",
          entry: "implement",
          name: "test-flow",
          spawn_instructions: { implement: "Do the thing" },
          states: {
            done: { type: "terminal" },
            implement: { agent: "canon-implementor", type: "single" },
          },
        } as ResolvedFlow),
      state_id: state_id ?? "implement",
      variables: variables ?? {},
      workspace: workspace ?? "/tmp/test-workspace",
      ...("role" in overrides ? { role } : {}),
      ...("wave" in overrides ? { wave } : {}),
    },
    mergedVariables: {},
    prompts: [makeEntry()],
    rawInstruction: "Do the thing",
    state: { agent: "canon-implementor", type: "single" } as StateDefinition,
    warnings: [],
    ...rest,
  };
}

/** Make a store mock that returns a session with the given slug. */
function makeStoreWithSlug(slug: string): ReturnType<typeof getExecutionStore> {
  return {
    getBoard: vi.fn().mockReturnValue(null),
    getSession: vi.fn().mockReturnValue({ slug }),
  } as unknown as ReturnType<typeof getExecutionStore>;
}

/** Make a store mock where getSession throws. */
function makeStoreWithBrokenSession(): ReturnType<typeof getExecutionStore> {
  return {
    getBoard: vi.fn().mockReturnValue(null),
    getSession: vi.fn().mockImplementation(() => {
      throw new Error("session not available");
    }),
  } as unknown as ReturnType<typeof getExecutionStore>;
}

/** Make a store mock where getSession returns null (no session). */
function makeStoreWithNoSession(): ReturnType<typeof getExecutionStore> {
  return {
    getBoard: vi.fn().mockReturnValue(null),
    getSession: vi.fn().mockReturnValue(null),
  } as unknown as ReturnType<typeof getExecutionStore>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Provenance section injection

describe("injectCoordination — commit provenance injection (step 3.5)", () => {
  it("injects ## Commit Provenance section when session slug is available", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithSlug("my-workflow-slug"));

    const ctx = makeCtx({ state_id: "implement" });
    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("## Commit Provenance");
  });

  it("provenance section contains Canon-Workflow trailer with session slug", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithSlug("my-workflow-slug"));

    const ctx = makeCtx({ state_id: "implement" });
    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("Canon-Workflow: my-workflow-slug");
  });

  it("provenance section contains Canon-Agent trailer with agent name", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithSlug("my-slug"));

    const ctx = makeCtx({
      prompts: [makeEntry({ agent: "canon-implementor" })],
      state_id: "implement",
    });
    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("Canon-Agent: canon-implementor");
  });

  it("provenance section contains Canon-State trailer with state_id", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithSlug("my-slug"));

    const ctx = makeCtx({ state_id: "review-code" });
    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("Canon-State: review-code");
  });

  it("provenance section includes Canon-Task when entry item has task_id", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithSlug("my-slug"));

    const ctx = makeCtx({
      prompts: [makeEntry({ item: { task_id: "provenance-01", description: "Task desc" } })],
      state_id: "implement",
    });
    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("Canon-Task: provenance-01");
  });

  it("provenance section omits Canon-Task when entry item is a plain string", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithSlug("my-slug"));

    const ctx = makeCtx({
      prompts: [makeEntry({ item: "some-string-item" })],
      state_id: "implement",
    });
    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).not.toContain("Canon-Task:");
  });

  it("provenance section omits Canon-Task when entry has no item", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithSlug("my-slug"));

    const ctx = makeCtx({
      prompts: [makeEntry({ item: undefined })],
      state_id: "implement",
    });
    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).not.toContain("Canon-Task:");
  });

  it("each prompt entry gets a per-entry provenance block (different task_ids for wave tasks)", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithSlug("multi-slug"));

    const ctx = makeCtx({
      prompts: [
        makeEntry({ item: { task_id: "task-01", description: "First task" } }),
        makeEntry({ item: { task_id: "task-02", description: "Second task" } }),
      ],
      state_id: "implement",
    });
    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).toContain("Canon-Task: task-01");
    expect(result.prompts[1].prompt).toContain("Canon-Task: task-02");
    // Each entry's task_id is unique
    expect(result.prompts[0].prompt).not.toContain("Canon-Task: task-02");
    expect(result.prompts[1].prompt).not.toContain("Canon-Task: task-01");
  });

  it("provenance section is appended after the metrics footer (ordering)", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithSlug("my-slug"));

    const ctx = makeCtx({ state_id: "implement" });
    const result = await injectCoordination(ctx);

    const prompt = result.prompts[0].prompt;
    const metricsPos = prompt.indexOf("## Performance Metrics");
    const provenancePos = prompt.indexOf("## Commit Provenance");

    expect(metricsPos).toBeGreaterThan(-1);
    expect(provenancePos).toBeGreaterThan(-1);
    expect(provenancePos).toBeGreaterThan(metricsPos);
  });

  it("does NOT inject provenance section when getSession throws (fail-safe)", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithBrokenSession());

    const ctx = makeCtx({ state_id: "implement" });
    const result = await injectCoordination(ctx);

    // buildProvenanceSection returns "" on exception — no section injected
    expect(result.prompts[0].prompt).not.toContain("## Commit Provenance");
    // Tool should still succeed
    expect(result.prompts[0].prompt).toContain("## Performance Metrics");
  });

  it("does NOT inject provenance section when session has no slug (fail-safe)", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithNoSession());

    const ctx = makeCtx({ state_id: "implement" });
    const result = await injectCoordination(ctx);

    expect(result.prompts[0].prompt).not.toContain("## Commit Provenance");
    // Metrics still present — rest of pipeline unaffected
    expect(result.prompts[0].prompt).toContain("## Performance Metrics");
  });

  it("provenance injection does not break empty prompts list", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithSlug("my-slug"));

    const ctx = makeCtx({
      prompts: [],
      state_id: "implement",
    });
    const result = await injectCoordination(ctx);

    expect(result.prompts).toHaveLength(0);
  });

  it("provenance section injected for all entries (unconditional, like metrics footer)", async () => {
    vi.mocked(getExecutionStore).mockReturnValue(makeStoreWithSlug("my-slug"));

    const ctx = makeCtx({
      prompts: [
        makeEntry({ prompt: "Task A" }),
        makeEntry({ prompt: "Task B" }),
        makeEntry({ prompt: "Task C" }),
      ],
      state_id: "implement",
    });
    const result = await injectCoordination(ctx);

    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("## Commit Provenance");
    }
  });
});
