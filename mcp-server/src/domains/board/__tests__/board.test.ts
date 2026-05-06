import { BoardSchema } from "@domains/flows/board-state-schemas.ts";
import { describe, expect, it } from "vitest";
import { initBoard } from "../board.ts";

// initBoard

describe("initBoard", () => {
  it("returns a valid Board that passes BoardSchema.parse()", () => {
    const board = initBoard("fast-path", "build feature X", "abc123");
    expect(() => BoardSchema.parse(board)).not.toThrow();
  });

  it("sets flow, task, base_commit, entry, and current_state correctly", () => {
    const board = initBoard("fast-path", "my task", "deadbeef");
    expect(board.flow).toBe("fast-path");
    expect(board.task).toBe("my task");
    expect(board.base_commit).toBe("deadbeef");
    expect(board.entry).toBe("init");
    expect(board.current_state).toBe("init");
  });

  it("returns empty states and iterations objects", () => {
    const board = initBoard("fast-path", "my task", "deadbeef");
    expect(board.states).toEqual({});
    expect(board.iterations).toEqual({});
  });

  it("sets blocked to null and empty arrays for concerns and skipped", () => {
    const board = initBoard("fast-path", "my task", "deadbeef");
    expect(board.blocked).toBeNull();
    expect(board.concerns).toEqual([]);
    expect(board.skipped).toEqual([]);
  });

  it("sets started and last_updated timestamps as ISO strings", () => {
    const board = initBoard("fast-path", "my task", "deadbeef");
    expect(board.started).toBeTruthy();
    expect(board.last_updated).toBeTruthy();
    expect(new Date(board.started).toISOString()).toBe(board.started);
    expect(new Date(board.last_updated).toISOString()).toBe(board.last_updated);
  });

  it("does not depend on ResolvedFlow — no flow object needed", () => {
    // This test documents that initBoard accepts only primitive strings.
    // Calling it with any valid strings should succeed.
    const board = initBoard("agent-teams-flow", "some task", "1234abcd");
    expect(board.flow).toBe("agent-teams-flow");
  });
});
