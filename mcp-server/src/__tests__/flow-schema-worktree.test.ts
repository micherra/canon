/**
 * Tests for WorktreeEntrySchema and WaveResultSchema worktree_entries field
 * in flow-schema.ts
 *
 * Covers:
 * - WorktreeEntrySchema parses valid entries
 * - WorktreeEntrySchema defaults status to "active"
 * - WaveResultSchema.parse() with worktree_entries — valid entries persisted
 * - WaveResultSchema.parse() without worktree_entries — backward compat (optional field)
 */

import { describe, it, expect } from "vitest";
import { WorktreeEntrySchema, WaveResultSchema } from "../orchestration/flow-schema.ts";

describe("WorktreeEntrySchema", () => {
  it("parses a valid worktree entry with all fields", () => {
    const result = WorktreeEntrySchema.parse({
      task_id: "rwf-01",
      worktree_path: "/tmp/worktrees/rwf-01",
      branch: "feat/rwf-01",
      status: "active",
    });

    expect(result.task_id).toBe("rwf-01");
    expect(result.worktree_path).toBe("/tmp/worktrees/rwf-01");
    expect(result.branch).toBe("feat/rwf-01");
    expect(result.status).toBe("active");
  });

  it("defaults status to 'active' when omitted", () => {
    const result = WorktreeEntrySchema.parse({
      task_id: "rwf-02",
      worktree_path: "/tmp/worktrees/rwf-02",
      branch: "feat/rwf-02",
    });

    expect(result.status).toBe("active");
  });

  it("accepts 'merged' status", () => {
    const result = WorktreeEntrySchema.parse({
      task_id: "rwf-03",
      worktree_path: "/tmp/worktrees/rwf-03",
      branch: "feat/rwf-03",
      status: "merged",
    });

    expect(result.status).toBe("merged");
  });

  it("accepts 'failed' status", () => {
    const result = WorktreeEntrySchema.parse({
      task_id: "rwf-04",
      worktree_path: "/tmp/worktrees/rwf-04",
      branch: "feat/rwf-04",
      status: "failed",
    });

    expect(result.status).toBe("failed");
  });

  it("rejects invalid status values", () => {
    expect(() =>
      WorktreeEntrySchema.parse({
        task_id: "rwf-05",
        worktree_path: "/tmp/worktrees/rwf-05",
        branch: "feat/rwf-05",
        status: "unknown",
      })
    ).toThrow();
  });
});

describe("WaveResultSchema — worktree_entries", () => {
  it("parses WaveResult with worktree_entries present", () => {
    const result = WaveResultSchema.parse({
      tasks: ["rwf-01", "rwf-02"],
      status: "done",
      worktree_entries: [
        {
          task_id: "rwf-01",
          worktree_path: "/tmp/worktrees/rwf-01",
          branch: "feat/rwf-01",
          status: "active",
        },
        {
          task_id: "rwf-02",
          worktree_path: "/tmp/worktrees/rwf-02",
          branch: "feat/rwf-02",
          status: "merged",
        },
      ],
    });

    expect(result.worktree_entries).toHaveLength(2);
    expect(result.worktree_entries![0].task_id).toBe("rwf-01");
    expect(result.worktree_entries![1].status).toBe("merged");
  });

  it("parses WaveResult without worktree_entries — backward compat", () => {
    // Existing wave results without worktree_entries must parse cleanly
    const result = WaveResultSchema.parse({
      tasks: ["task-01", "task-02"],
      status: "done",
    });

    expect(result.tasks).toEqual(["task-01", "task-02"]);
    expect(result.worktree_entries).toBeUndefined();
  });

  it("parses WaveResult with all existing fields and no worktree_entries", () => {
    const result = WaveResultSchema.parse({
      tasks: ["task-01"],
      status: "pending",
      gate: "npm test",
      gate_output: "All tests passed",
      consultations: {
        before: { "canon-guide": { status: "done", summary: "OK" } },
      },
    });

    expect(result.worktree_entries).toBeUndefined();
    expect(result.gate).toBe("npm test");
  });

  it("defaults status field in nested worktree entries when omitted", () => {
    const result = WaveResultSchema.parse({
      tasks: ["rwf-01"],
      status: "done",
      worktree_entries: [
        {
          task_id: "rwf-01",
          worktree_path: "/tmp/worktrees/rwf-01",
          branch: "feat/rwf-01",
          // no status
        },
      ],
    });

    expect(result.worktree_entries![0].status).toBe("active");
  });
});
