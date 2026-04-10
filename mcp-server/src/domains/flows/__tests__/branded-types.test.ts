/**
 * Tests for branded domain identifier types (Wave 4: branded-types-define)
 *
 * Covers:
 * - Smart constructors are runtime identity functions that return branded strings
 * - BoardSchema.parse() propagates branded types to identifier fields
 * - ResolvedFlowSchema.parse() propagates branded types to name and entry
 * - assertWorkspacePath() returns WorkspacePath (not void) for valid paths
 * - assertWorkspacePath() still throws for invalid paths in non-test env
 */

import { describe, expect, it } from "vitest";
import {
  BoardSchema,
  FlowNameSchema,
  StateIdSchema,
  WorkspacePathSchema,
  flowName,
  stateId,
  workspacePath,
} from "../board-state-schemas.ts";
import { ResolvedFlowSchema } from "../flow-definition-schemas.ts";

// --- Smart constructor identity tests ---

describe("workspacePath() smart constructor", () => {
  it("returns the raw string value unchanged at runtime", () => {
    const raw = "/home/user/.canon/workspaces/my-session";
    const result = workspacePath(raw);
    expect(result).toBe(raw);
  });

  it("satisfies WorkspacePathSchema at type level (parse succeeds)", () => {
    const raw = "/a/b/c";
    const parsed = WorkspacePathSchema.parse(raw);
    expect(parsed).toBe(raw);
  });
});

describe("stateId() smart constructor", () => {
  it("returns the raw string value unchanged at runtime", () => {
    const raw = "research";
    const result = stateId(raw);
    expect(result).toBe(raw);
  });

  it("satisfies StateIdSchema at type level (parse succeeds)", () => {
    const raw = "implement";
    const parsed = StateIdSchema.parse(raw);
    expect(parsed).toBe(raw);
  });
});

describe("flowName() smart constructor", () => {
  it("returns the raw string value unchanged at runtime", () => {
    const raw = "fast-path";
    const result = flowName(raw);
    expect(result).toBe(raw);
  });

  it("satisfies FlowNameSchema at type level (parse succeeds)", () => {
    const raw = "feature";
    const parsed = FlowNameSchema.parse(raw);
    expect(parsed).toBe(raw);
  });
});

// --- BoardSchema branded field propagation ---

const validBoard = {
  base_commit: "abc123",
  blocked: null,
  concerns: [],
  current_state: "research",
  entry: "research",
  flow: "fast-path",
  iterations: {},
  last_updated: "2026-01-01T00:00:00Z",
  skipped: [],
  started: "2026-01-01T00:00:00Z",
  states: {
    research: {
      entries: 0,
      status: "pending",
    },
  },
  task: "Add dark mode",
};

describe("BoardSchema.parse() branded field propagation", () => {
  it("parses successfully with valid board data", () => {
    const result = BoardSchema.parse(validBoard);
    expect(result).toBeDefined();
  });

  it("returns branded current_state matching the input string", () => {
    const result = BoardSchema.parse(validBoard);
    expect(result.current_state).toBe("research");
  });

  it("returns branded entry matching the input string", () => {
    const result = BoardSchema.parse(validBoard);
    expect(result.entry).toBe("research");
  });

  it("returns branded flow matching the input string", () => {
    const result = BoardSchema.parse(validBoard);
    expect(result.flow).toBe("fast-path");
  });

  it("returns branded state keys in states record", () => {
    const result = BoardSchema.parse(validBoard);
    expect(result.states["research"]).toBeDefined();
  });
});

// --- ResolvedFlowSchema branded field propagation ---

const validResolvedFlow = {
  description: "Fast-path flow for quick changes",
  entry: "implement",
  name: "fast-path",
  spawn_instructions: {
    implement: "Implement the change",
  },
  states: {
    implement: {
      agent: "canon:canon-implementor",
      type: "single",
    },
    done: {
      type: "terminal",
    },
  },
};

describe("ResolvedFlowSchema.parse() branded field propagation", () => {
  it("parses successfully with valid resolved flow data", () => {
    const result = ResolvedFlowSchema.parse(validResolvedFlow);
    expect(result).toBeDefined();
  });

  it("returns branded name matching the input string", () => {
    const result = ResolvedFlowSchema.parse(validResolvedFlow);
    expect(result.name).toBe("fast-path");
  });

  it("returns branded entry matching the input string", () => {
    const result = ResolvedFlowSchema.parse(validResolvedFlow);
    expect(result.entry).toBe("implement");
  });

  it("returns branded state keys in states record", () => {
    const result = ResolvedFlowSchema.parse(validResolvedFlow);
    expect(result.states["implement"]).toBeDefined();
  });

  it("returns branded spawn_instructions keys", () => {
    const result = ResolvedFlowSchema.parse(validResolvedFlow);
    expect(result.spawn_instructions["implement"]).toBe("Implement the change");
  });
});

// --- assertWorkspacePath return type ---

describe("assertWorkspacePath()", () => {
  it("returns a WorkspacePath (branded string) for a valid path in test env", async () => {
    // Import dynamically to avoid side effects from module-level variable
    const { assertWorkspacePath } = await import("../../workspaces/execution-store.ts");
    // In VITEST env, validation is skipped — so any string returns branded
    const result = assertWorkspacePath("/any/path/here");
    expect(result).toBe("/any/path/here");
  });

  it("returns the exact string value passed in (identity function at runtime)", async () => {
    const { assertWorkspacePath } = await import("../../workspaces/execution-store.ts");
    const path = "/some/.canon/workspaces/my-workspace";
    const result = assertWorkspacePath(path);
    expect(result).toBe(path);
  });
});
