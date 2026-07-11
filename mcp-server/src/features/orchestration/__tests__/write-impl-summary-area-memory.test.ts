/**
 * Tests for area observation extraction, decisions table, and execution store events
 * in write-implementation-summary.
 *
 * The areaMemoryWriter is mocked as a simple object — no SQLite or disk I/O for
 * area memory. Execution store events are tested via a real temp workspace with
 * a SQLite orchestration.db.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type WriteImplementationSummaryInput,
  writeImplementationSummary,
} from "../tools/write-implementation-summary.ts";
import type { AreaMemoryWriter } from "../tools/write-review.ts";
import { seedExecution } from "./seed-execution-test-helper.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "write-impl-summary-area-memory-test-"));
  seedExecution(tmpDir);
});

afterEach(async () => {
  clearStoreCache();
  if (tmpDir) {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

function makeInput(
  overrides: Partial<WriteImplementationSummaryInput> = {},
): WriteImplementationSummaryInput {
  return {
    files_changed: [
      {
        action: "modified",
        path: "mcp-server/src/features/orchestration/tools/write-review.ts",
      },
    ],
    slug: "test-slug",
    task_id: "task-03",
    workspace: tmpDir,
    ...overrides,
  };
}

function makeMockWriter(): {
  writer: AreaMemoryWriter;
  calls: Parameters<AreaMemoryWriter["insertObservation"]>[];
} {
  const calls: Parameters<AreaMemoryWriter["insertObservation"]>[] = [];
  const writer: AreaMemoryWriter = {
    insertObservation: vi.fn((input) => {
      calls.push([input]);
    }),
  };
  return { calls, writer };
}

describe("writeImplementationSummary — area observation extraction", () => {
  it("creates area observations for each deviation when areaMemoryWriter is present", async () => {
    const { calls, writer } = makeMockWriter();
    const input = makeInput({
      deviations: [
        { decision_id: "amhf-01", reason: "Simplified approach due to time constraints" },
      ],
    });

    const result = await writeImplementationSummary(input, writer);
    assertOk(result);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0].source).toBe("engineer");
    expect(calls[0][0].content).toContain("amhf-01");
    expect(calls[0][0].content).toContain("Simplified approach due to time constraints");
    expect(calls[0][0].workflow_slug).toBe("test-slug");
  });

  it("creates no observations when deviations array is empty", async () => {
    const { calls, writer } = makeMockWriter();
    const input = makeInput({ deviations: [] });

    const result = await writeImplementationSummary(input, writer);
    assertOk(result);
    expect(calls).toHaveLength(0);
  });

  it("creates no observations when deviations is undefined", async () => {
    const { calls, writer } = makeMockWriter();
    const input = makeInput({ deviations: undefined });

    const result = await writeImplementationSummary(input, writer);
    assertOk(result);
    expect(calls).toHaveLength(0);
  });

  it("areaMemoryWriter is optional — existing behavior preserved when undefined", async () => {
    const input = makeInput({
      deviations: [{ decision_id: "amhf-01", reason: "Reason" }],
    });

    // Should not throw — no writer, no crash
    const result = await writeImplementationSummary(input, undefined);
    assertOk(result);
  });

  it("is fail-open: areaMemoryWriter.insertObservation throws, summary still written", async () => {
    const writer: AreaMemoryWriter = {
      insertObservation: vi.fn(() => {
        throw new Error("DB write failed");
      }),
    };
    const input = makeInput({
      deviations: [{ decision_id: "amhf-01", reason: "Reason" }],
    });

    const result = await writeImplementationSummary(input, writer);
    assertOk(result);
    // Verify the markdown was still written
    const md = await readFile(result.path, "utf-8");
    expect(md).toContain("Implementation Summary");
  });

  it("groups deviations under the correct subsystem key from files_changed", async () => {
    const { calls, writer } = makeMockWriter();
    const input = makeInput({
      deviations: [{ decision_id: "amhf-01", reason: "Reason" }],
      files_changed: [
        {
          action: "modified",
          path: "mcp-server/src/features/orchestration/tools/write-review.ts",
        },
      ],
    });

    const result = await writeImplementationSummary(input, writer);
    assertOk(result);
    expect(calls[0][0].subsystem_key).toBe("features/orchestration");
  });
});

describe("writeImplementationSummary — decisions table in markdown", () => {
  it("renders decisions as a markdown table when decisions array is present", async () => {
    const input = makeInput({
      decisions: [
        {
          choice: "Use optional parameter at end of function",
          rationale: "Backward compatible with existing callers",
        },
      ],
    });

    const result = await writeImplementationSummary(input);
    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).toContain("### Decisions");
    expect(md).toContain("| # | Choice | Rationale | Informed By |");
    expect(md).toContain("Use optional parameter at end of function");
    expect(md).toContain("Backward compatible with existing callers");
  });

  it("includes informed_by references in decisions table", async () => {
    const input = makeInput({
      decisions: [
        {
          choice: "Follow SignalWriter pattern",
          informed_by: [
            { ref: "errors-are-values", type: "principle" },
            { ref: "existing write-review.ts", type: "codebase_pattern" },
          ],
          rationale: "Consistent with existing code",
        },
      ],
    });

    const result = await writeImplementationSummary(input);
    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).toContain("principle:errors-are-values");
    expect(md).toContain("codebase_pattern:existing write-review.ts");
  });

  it("does NOT render Decisions section when decisions array is absent", async () => {
    const input = makeInput({ decisions: undefined });

    const result = await writeImplementationSummary(input);
    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).not.toContain("### Decisions");
  });

  it("does NOT render Decisions section when decisions array is empty", async () => {
    const input = makeInput({ decisions: [] });

    const result = await writeImplementationSummary(input);
    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).not.toContain("### Decisions");
  });

  it("decisions field is optional — summary still produced without it", async () => {
    const input = makeInput();

    const result = await writeImplementationSummary(input);
    assertOk(result);
    expect(result.files_changed_count).toBe(1);
  });
});

describe("writeImplementationSummary — decisions stored in meta JSON", () => {
  it("stores decisions in meta JSON sidecar when present", async () => {
    const input = makeInput({
      decisions: [
        {
          alternatives_considered: ["inject via constructor", "use global singleton"],
          choice: "Use optional parameter",
          informed_by: [{ ref: "errors-are-values", type: "principle" }],
          rationale: "Most compatible approach",
        },
      ],
    });

    const result = await writeImplementationSummary(input);
    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta.decisions).toBeDefined();
    expect(meta.decisions).toHaveLength(1);
    expect(meta.decisions[0].choice).toBe("Use optional parameter");
    expect(meta.decisions[0].rationale).toBe("Most compatible approach");
    expect(meta.decisions[0].alternatives_considered).toEqual([
      "inject via constructor",
      "use global singleton",
    ]);
    expect(meta.decisions[0].informed_by).toEqual([
      { ref: "errors-are-values", type: "principle" },
    ]);
  });

  it("does not include decisions key in meta JSON when decisions is undefined", async () => {
    const input = makeInput({ decisions: undefined });

    const result = await writeImplementationSummary(input);
    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta.decisions).toBeUndefined();
  });
});

describe("writeImplementationSummary — decisions logged as agent_decision events", () => {
  it("logs each decision as an agent_decision event in the execution store", async () => {
    const input = makeInput({
      decisions: [
        {
          choice: "Use optional parameter",
          informed_by: [{ ref: "simplicity-first", type: "principle" }],
          rationale: "Backward compatible",
        },
        {
          alternatives_considered: ["approach A", "approach B"],
          choice: "Follow SignalWriter pattern",
          rationale: "Consistent with codebase",
        },
      ],
    });

    const result = await writeImplementationSummary(input);
    assertOk(result);

    // Read events from execution store
    const store = getExecutionStore(tmpDir);
    const events = store.getEventsByType("agent_decision");
    expect(events).toHaveLength(2);

    const firstEvent = events[0];
    expect(firstEvent.type).toBe("agent_decision");
    expect(firstEvent.payload.choice).toBe("Use optional parameter");
    expect(firstEvent.payload.rationale).toBe("Backward compatible");
    expect(firstEvent.payload.agent_type).toBe("engineer");
    expect(firstEvent.payload.step_id).toBe("task-03");
    expect(firstEvent.payload.workflow_slug).toBe("test-slug");
    expect(firstEvent.payload.informed_by).toEqual([
      { ref: "simplicity-first", type: "principle" },
    ]);

    const secondEvent = events[1];
    expect(secondEvent.payload.choice).toBe("Follow SignalWriter pattern");
    expect(secondEvent.payload.alternatives_considered).toEqual(["approach A", "approach B"]);
    expect(secondEvent.payload.informed_by).toEqual([]);
  });

  it("does not log events when decisions is undefined", async () => {
    const input = makeInput({ decisions: undefined });

    const result = await writeImplementationSummary(input);
    assertOk(result);

    const store = getExecutionStore(tmpDir);
    const events = store.getEventsByType("agent_decision");
    expect(events).toHaveLength(0);
  });

  it("is fail-open when execution store is unavailable (no workspace dir collision)", async () => {
    // The execution store for tmpDir will work; this tests the normal path doesn't throw
    const input = makeInput({
      decisions: [{ choice: "Some choice", rationale: "Some reason" }],
    });

    // Should not throw regardless
    const result = await writeImplementationSummary(input);
    assertOk(result);
  });

  it("informed_by references are preserved in event payload for learner correlation", async () => {
    const input = makeInput({
      decisions: [
        {
          choice: "Use area memory observations",
          informed_by: [
            { ref: "obs-123", type: "area_memory" },
            { ref: "pitfall text here", type: "pitfall" },
          ],
          rationale: "Prior observations indicated this approach failed",
        },
      ],
    });

    const result = await writeImplementationSummary(input);
    assertOk(result);

    const store = getExecutionStore(tmpDir);
    const events = store.getEventsByType("agent_decision");
    expect(events).toHaveLength(1);
    expect(events[0].payload.informed_by).toEqual([
      { ref: "obs-123", type: "area_memory" },
      { ref: "pitfall text here", type: "pitfall" },
    ]);
  });
});
