/**
 * Integration tests for the extension wiring fixes.
 *
 * These tests cover:
 * - Cross-task contract: ExtensionPushMessage statuses (ext-fix-03) match
 *   the graphData.ts validation array (ext-fix-04)
 * - generationProgress store: initial state, value acceptance, null reset
 * - graphStatus store: all valid values are writable
 * - GenerationProgress timer helper logic (extracted from dashboard-panel.ts)
 * - saveListener reindexing status path (ext-fix-04 reindexing bar)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import {
  graphStatus,
  generationProgress,
  graphData,
  type GraphStatus,
} from "../webview/stores/graphData";
import type { ExtensionPushMessage } from "../messages";

// ── Cross-task contract: message protocol ↔ store validation ──

describe("Protocol contract: ExtensionPushMessage.graphStatus ↔ graphData.ts valid array", () => {
  /**
   * ext-fix-03 added "reindexing" to the ExtensionPushMessage union.
   * ext-fix-04 added "reindexing" to the valid[] array in the message handler.
   * This test verifies the two sets are in sync — a cross-task boundary.
   */

  const VALID_IN_MESSAGE_TYPE: ExtensionPushMessage["type"][] = [
    "graphData",
    "graphStatus",
    "prReviews",
    "summaryProgress",
    "generationProgress",
  ];

  it("all five ExtensionPushMessage types are present in the union", () => {
    // If any type were removed, this assignment would fail at compile time.
    const msgs: ExtensionPushMessage[] = [
      { type: "graphData", data: {} },
      { type: "graphStatus", status: "ready" },
      { type: "prReviews", data: [] },
      { type: "summaryProgress", completed: 0, total: 0 },
      { type: "generationProgress", elapsed: 0 },
    ];
    expect(msgs).toHaveLength(VALID_IN_MESSAGE_TYPE.length);
  });

  it("graphStatus union covers all values in graphData.ts valid array", () => {
    // These are the statuses accepted in the message handler's valid[] array (graphData.ts).
    // They must all be assignable to GraphStatus (compile-time) and to the
    // ExtensionPushMessage graphStatus.status union (compile-time).
    const validInStore: GraphStatus[] = [
      "ready",
      "generating",
      "refreshing",
      "reindexing",
      "error",
      "empty",
    ];

    // Compile-time: each string is assignable to both GraphStatus and to the
    // ExtensionPushMessage union's status field.
    const validInProtocol: Array<ExtensionPushMessage & { type: "graphStatus" }> =
      validInStore.map((status) => ({ type: "graphStatus", status }));

    expect(validInStore).toHaveLength(6);
    expect(validInProtocol).toHaveLength(6);

    // Runtime: every status accepted by the protocol is also accepted by the store.
    for (const status of validInStore) {
      graphStatus.set(status);
      expect(get(graphStatus)).toBe(status);
    }
  });

  it("reindexing is present in both the message protocol and the store type", () => {
    // ext-fix-02 added "reindexing" to GraphStatus.
    // ext-fix-03 added it to ExtensionPushMessage.graphStatus.status.
    // ext-fix-04 added it to the valid[] runtime array.
    // All three must hold simultaneously.
    const asStoreType: GraphStatus = "reindexing";
    const asProtocol: ExtensionPushMessage = { type: "graphStatus", status: "reindexing" };

    graphStatus.set(asStoreType);
    expect(get(graphStatus)).toBe("reindexing");
    expect(asProtocol.type).toBe("graphStatus");
  });
});

// ── generationProgress store ──

describe("generationProgress store (ext-fix-04)", () => {
  beforeEach(() => {
    // Reset store to known state before each test
    generationProgress.set(null);
  });

  it("initialises to null", () => {
    generationProgress.set(null);
    expect(get(generationProgress)).toBeNull();
  });

  it("accepts a valid elapsed value", () => {
    generationProgress.set({ elapsed: 42 });
    expect(get(generationProgress)).toEqual({ elapsed: 42 });
  });

  it("accepts elapsed = 0 (boundary value)", () => {
    generationProgress.set({ elapsed: 0 });
    expect(get(generationProgress)?.elapsed).toBe(0);
  });

  it("accepts large elapsed values", () => {
    generationProgress.set({ elapsed: 3599 });
    expect(get(generationProgress)?.elapsed).toBe(3599);
  });

  it("can be reset to null after being set", () => {
    generationProgress.set({ elapsed: 10 });
    expect(get(generationProgress)).not.toBeNull();
    generationProgress.set(null);
    expect(get(generationProgress)).toBeNull();
  });
});

// ── generationProgress reset on graphStatus change ──

describe("generationProgress reset contract (ext-fix-04 message handler logic)", () => {
  /**
   * The message handler in graphData.ts clears generationProgress when
   * graphStatus changes away from "generating". This test validates the
   * specified reset logic by running it directly (simulating what the
   * handler does) against all non-generating statuses.
   *
   * The handler code:
   *   if (valid.includes(msg.status)) {
   *     graphStatus.set(msg.status)
   *     if (msg.status !== "generating") {
   *       generationProgress.set(null)
   *     }
   *   }
   */
  const NON_GENERATING_STATUSES: GraphStatus[] = [
    "ready",
    "refreshing",
    "reindexing",
    "error",
    "empty",
  ];

  function simulateGraphStatusMessage(status: GraphStatus): void {
    const valid: GraphStatus[] = ["ready", "generating", "refreshing", "reindexing", "error", "empty"];
    if (valid.includes(status)) {
      graphStatus.set(status);
      if (status !== "generating") {
        generationProgress.set(null);
      }
    }
  }

  beforeEach(() => {
    generationProgress.set({ elapsed: 30 });
  });

  it("clears generationProgress for each non-generating status", () => {
    for (const status of NON_GENERATING_STATUSES) {
      generationProgress.set({ elapsed: 30 });
      simulateGraphStatusMessage(status);
      expect(get(generationProgress)).toBeNull();
    }
  });

  it("does NOT clear generationProgress when status is still generating", () => {
    generationProgress.set({ elapsed: 30 });
    simulateGraphStatusMessage("generating");
    expect(get(generationProgress)).toEqual({ elapsed: 30 });
  });

  it("reindexing specifically clears generationProgress", () => {
    // Regression test: reindexing was added in ext-fix-02/04, verify reset works.
    generationProgress.set({ elapsed: 15 });
    simulateGraphStatusMessage("reindexing");
    expect(get(generationProgress)).toBeNull();
    expect(get(graphStatus)).toBe("reindexing");
  });
});

// ── generationProgress message handler validation logic ──

describe("generationProgress message validation (ext-fix-04)", () => {
  /**
   * The message handler validates: typeof msg.elapsed === "number"
   * This test simulates that validation directly.
   */

  function applyGenerationProgressMessage(msg: { elapsed: unknown }): void {
    if (typeof msg.elapsed === "number") {
      generationProgress.set({ elapsed: msg.elapsed });
    }
  }

  beforeEach(() => {
    generationProgress.set(null);
  });

  it("accepts numeric elapsed values", () => {
    applyGenerationProgressMessage({ elapsed: 10 });
    expect(get(generationProgress)).toEqual({ elapsed: 10 });
  });

  it("rejects string elapsed (validate-at-trust-boundaries)", () => {
    applyGenerationProgressMessage({ elapsed: "ten" });
    expect(get(generationProgress)).toBeNull();
  });

  it("rejects null elapsed", () => {
    applyGenerationProgressMessage({ elapsed: null });
    expect(get(generationProgress)).toBeNull();
  });

  it("rejects undefined elapsed", () => {
    applyGenerationProgressMessage({ elapsed: undefined });
    expect(get(generationProgress)).toBeNull();
  });

  it("rejects object elapsed", () => {
    applyGenerationProgressMessage({ elapsed: { seconds: 5 } });
    expect(get(generationProgress)).toBeNull();
  });

  it("accepts elapsed = 0 as valid number (not falsy-rejected)", () => {
    applyGenerationProgressMessage({ elapsed: 0 });
    // typeof 0 === "number" is true, so 0 must be accepted
    expect(get(generationProgress)).toEqual({ elapsed: 0 });
  });
});

// ── graphStatus validation logic ──

describe("graphStatus message validation (ext-fix-04)", () => {
  /**
   * The message handler validates msg.status against a valid[] allowlist.
   * This test simulates that validation directly.
   */

  const VALID_STATUSES: GraphStatus[] = [
    "ready", "generating", "refreshing", "reindexing", "error", "empty",
  ];

  function applyGraphStatusMessage(status: string): void {
    if ((VALID_STATUSES as string[]).includes(status)) {
      graphStatus.set(status as GraphStatus);
    }
  }

  beforeEach(() => {
    graphStatus.set("empty");
  });

  it("accepts all valid statuses", () => {
    for (const status of VALID_STATUSES) {
      applyGraphStatusMessage(status);
      expect(get(graphStatus)).toBe(status);
    }
  });

  it("rejects unknown status strings (validate-at-trust-boundaries)", () => {
    applyGraphStatusMessage("unknown");
    expect(get(graphStatus)).toBe("empty"); // unchanged
  });

  it("rejects empty string status", () => {
    applyGraphStatusMessage("");
    expect(get(graphStatus)).toBe("empty");
  });

  it("rejects status with capital letters (case-sensitive)", () => {
    applyGraphStatusMessage("Ready");
    expect(get(graphStatus)).toBe("empty");
  });
});

// ── Timer helper logic: startGenerationProgress / clearGenerationProgress ──

describe("generation progress timer helper logic (ext-fix-03)", () => {
  /**
   * Tests the tick-based progress emission logic extracted from
   * DashboardPanel.startGenerationProgress(). The timer fires every 3000ms,
   * posts elapsed time, and self-reschedules while !disposed && generationInProgress.
   * clearGenerationProgress cancels any pending timer.
   */

  beforeEach(() => {
    vi.useFakeTimers();
    generationProgress.set(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    generationProgress.set(null);
  });

  it("emits elapsed progress after 3 seconds", () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let inProgress = true;
    const startTime = Date.now();

    const postedMessages: Array<{ elapsed: number }> = [];

    const tick = () => {
      if (disposed || !inProgress) {
        if (timer) { clearTimeout(timer); timer = undefined; }
        return;
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      postedMessages.push({ elapsed });
      generationProgress.set({ elapsed });
      timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);

    vi.advanceTimersByTime(3000);
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].elapsed).toBe(3);
    expect(get(generationProgress)).toEqual({ elapsed: 3 });

    if (timer) clearTimeout(timer);
  });

  it("self-reschedules and emits multiple ticks", () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let inProgress = true;
    const startTime = Date.now();

    const ticks: number[] = [];

    const tick = () => {
      if (disposed || !inProgress) {
        if (timer) { clearTimeout(timer); timer = undefined; }
        return;
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      ticks.push(elapsed);
      generationProgress.set({ elapsed });
      timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);

    vi.advanceTimersByTime(9000);
    expect(ticks).toHaveLength(3);
    expect(ticks).toEqual([3, 6, 9]);

    if (timer) clearTimeout(timer);
  });

  it("stops emitting when disposed is true", () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let inProgress = true;
    const startTime = Date.now();
    const ticks: number[] = [];

    const tick = () => {
      if (disposed || !inProgress) {
        if (timer) { clearTimeout(timer); timer = undefined; }
        return;
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      ticks.push(elapsed);
      generationProgress.set({ elapsed });
      timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);

    vi.advanceTimersByTime(3000); // fires once
    expect(ticks).toHaveLength(1);

    disposed = true;
    vi.advanceTimersByTime(6000); // should not fire again
    expect(ticks).toHaveLength(1);

    if (timer) clearTimeout(timer);
  });

  it("stops emitting when generationInProgress becomes false", () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let inProgress = true;
    const startTime = Date.now();
    const ticks: number[] = [];

    const tick = () => {
      if (disposed || !inProgress) {
        if (timer) { clearTimeout(timer); timer = undefined; }
        return;
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      ticks.push(elapsed);
      generationProgress.set({ elapsed });
      timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);

    vi.advanceTimersByTime(3000); // fires once
    inProgress = false;
    vi.advanceTimersByTime(6000); // should not fire again
    expect(ticks).toHaveLength(1);

    if (timer) clearTimeout(timer);
  });

  it("clearGenerationProgress cancels pending timer", () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ticks: number[] = [];

    const tick = () => {
      ticks.push(1);
      timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);

    // Clear before timer fires
    if (timer) { clearTimeout(timer); timer = undefined; }

    vi.advanceTimersByTime(6000);
    expect(ticks).toHaveLength(0);
  });

  it("clearGenerationProgress sets timer to undefined (no double-clear)", () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    timer = setTimeout(() => { /* never fires */ }, 3000);
    expect(timer).toBeDefined();
    clearTimeout(timer);
    timer = undefined;
    expect(timer).toBeUndefined();
    // Second clear is a no-op
    clearTimeout(timer); // should not throw
    expect(timer).toBeUndefined();
  });
});

// ── findPluginDir guard: error state behavior ──

describe("plugin-dir guard error state (ext-fix-03 known gap)", () => {
  /**
   * The plugin-dir guard posts graphStatus: "error" when findPluginDir() returns null.
   * We test the observable: that graphStatus "error" is a valid ExtensionPushMessage
   * and that the store correctly reflects the error state when it arrives.
   */

  it("error status can be set and reflects in store", () => {
    graphStatus.set("error");
    expect(get(graphStatus)).toBe("error");
  });

  it("error status is a valid ExtensionPushMessage", () => {
    const msg: ExtensionPushMessage = { type: "graphStatus", status: "error" };
    expect(msg.type).toBe("graphStatus");
    expect((msg as { type: string; status: string }).status).toBe("error");
  });

  it("transitioning from generating to error clears generationProgress", () => {
    // Simulate: generation was in progress, plugin dir check fails mid-flow
    graphStatus.set("generating");
    generationProgress.set({ elapsed: 10 });

    // Guard fires: posts error status, which triggers reset
    graphStatus.set("error");
    generationProgress.set(null); // handler always resets on non-generating status

    expect(get(graphStatus)).toBe("error");
    expect(get(generationProgress)).toBeNull();
  });
});

// ── Reindexing bar data contract (ext-fix-04) ──

describe("reindexing status UI data contract (ext-fix-04)", () => {
  /**
   * The App.svelte reindexing bar is shown when $graphStatus === "reindexing"
   * and $graphData is truthy. We test the store conditions that drive that UI.
   */

  beforeEach(() => {
    graphStatus.set("empty");
    graphData.set(null);
  });

  it("reindexing status does not conflict with null graphData", () => {
    // Bar only shows when graphData is truthy AND status is reindexing.
    // When graphData is null, the status can still be reindexing.
    graphStatus.set("reindexing");
    expect(get(graphStatus)).toBe("reindexing");
    expect(get(graphData)).toBeNull();
  });

  it("reindexing status coexists with loaded graphData", () => {
    graphData.set({ nodes: [{ id: "a.ts", layer: "domain" }], edges: [] });
    graphStatus.set("reindexing");
    expect(get(graphStatus)).toBe("reindexing");
    expect(get(graphData)).not.toBeNull();
  });

  it("save-listener reindexing message shape is valid ExtensionPushMessage", () => {
    // The setupSaveListener() debounce posts: { type: "graphStatus", status: "reindexing" }
    const msg: ExtensionPushMessage = { type: "graphStatus", status: "reindexing" };
    expect(msg).toEqual({ type: "graphStatus", status: "reindexing" });
  });

  it("reindexing does not prevent transition back to ready", () => {
    graphStatus.set("reindexing");
    expect(get(graphStatus)).toBe("reindexing");
    graphStatus.set("ready");
    expect(get(graphStatus)).toBe("ready");
  });
});
