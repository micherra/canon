/**
 * Regression guard for WorktreeEntrySchema and WaveResultSchema as internal sub-schemas
 * of BoardStateEntrySchema. These schemas are no longer exported directly; they are
 * exercised here indirectly via BoardStateEntrySchema.wave_results, which embeds
 * WaveResultSchema (which in turn embeds WorktreeEntrySchema).
 */

import { describe, expect, it } from "vitest";
import { BoardStateEntrySchema } from "../board-state-schemas.ts";

describe("BoardStateEntrySchema.wave_results (WorktreeEntrySchema + WaveResultSchema integration)", () => {
  it("accepts wave_results with worktree_entries present", () => {
    const result = BoardStateEntrySchema.parse({
      status: "done",
      wave_results: {
        "wave-1": {
          status: "done",
          tasks: ["rwf-01", "rwf-02"],
          worktree_entries: [
            {
              branch: "feat/rwf-01",
              status: "active",
              task_id: "rwf-01",
              worktree_path: "/tmp/worktrees/rwf-01",
            },
            {
              branch: "feat/rwf-02",
              status: "merged",
              task_id: "rwf-02",
              worktree_path: "/tmp/worktrees/rwf-02",
            },
          ],
        },
      },
    });

    const waveResult = result.wave_results?.["wave-1"];
    expect(waveResult).toBeDefined();
    expect(waveResult?.worktree_entries).toHaveLength(2);
    expect(waveResult?.worktree_entries?.[0].task_id).toBe("rwf-01");
    expect(waveResult?.worktree_entries?.[1].status).toBe("merged");
  });

  it("defaults worktree_entry status to 'active' when omitted", () => {
    const result = BoardStateEntrySchema.parse({
      status: "in_progress",
      wave_results: {
        "wave-1": {
          status: "done",
          tasks: ["rwf-01"],
          worktree_entries: [
            {
              branch: "feat/rwf-01",
              task_id: "rwf-01",
              worktree_path: "/tmp/worktrees/rwf-01",
            },
          ],
        },
      },
    });

    expect(result.wave_results?.["wave-1"]?.worktree_entries?.[0].status).toBe("active");
  });

  it("accepts wave_results without worktree_entries (backward compat)", () => {
    const result = BoardStateEntrySchema.parse({
      status: "done",
      wave_results: {
        "wave-1": {
          status: "done",
          tasks: ["task-01", "task-02"],
        },
      },
    });

    expect(result.wave_results?.["wave-1"]?.worktree_entries).toBeUndefined();
    expect(result.wave_results?.["wave-1"]?.tasks).toEqual(["task-01", "task-02"]);
  });

  it("rejects invalid worktree_entry status value", () => {
    expect(() =>
      BoardStateEntrySchema.parse({
        status: "pending",
        wave_results: {
          "wave-1": {
            status: "done",
            tasks: ["t"],
            worktree_entries: [
              {
                branch: "b",
                status: "abandoned", // invalid
                task_id: "t",
                worktree_path: "/tmp/t",
              },
            ],
          },
        },
      }),
    ).toThrow();
  });
});
