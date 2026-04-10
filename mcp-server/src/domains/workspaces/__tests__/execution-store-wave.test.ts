/**
 * ExecutionStore — SQLite-backed orchestration state DAO
 *
 * Tests use in-memory SQLite (:memory:) for speed and isolation.
 * Each describe block gets a fresh DB via beforeEach.
 *
 * File 2 of 3: appendProgress+getProgress, appendMessage+getMessages,
 *              wave events lifecycle, appendEvent, transaction
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { initExecutionDb } from "../execution-schema.ts";
import { ExecutionStore } from "../execution-store.ts";

function makeDb(): Database.Database {
  return initExecutionDb(":memory:");
}

function makeStore(): ExecutionStore {
  return new ExecutionStore(makeDb());
}

// appendProgress + getProgress

describe("appendProgress + getProgress", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("returns empty string when no entries", () => {
    expect(store.getProgress()).toBe("");
  });

  test("appends and retrieves progress entries verbatim (no prefix added)", () => {
    store.appendProgress("Research complete");
    store.appendProgress("Implementation started");
    const progress = store.getProgress();
    // getProgress returns lines verbatim — no "- " prefix is added
    expect(progress).toContain("Research complete");
    expect(progress).toContain("Implementation started");
    // No double-bullet: "- " is NOT added by getProgress
    expect(progress).not.toContain("- Research complete");
    expect(progress).not.toContain("- Implementation started");
  });

  test("entries are ordered by insertion order", () => {
    store.appendProgress("first");
    store.appendProgress("second");
    store.appendProgress("third");
    const progress = store.getProgress();
    const lines = progress.split("\n").filter(Boolean);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
    expect(lines[2]).toContain("third");
  });

  test("respects maxEntries limit", () => {
    store.appendProgress("entry-1");
    store.appendProgress("entry-2");
    store.appendProgress("entry-3");
    store.appendProgress("entry-4");
    const progress = store.getProgress(2);
    // Should return last 2 entries
    expect(progress).toContain("entry-3");
    expect(progress).toContain("entry-4");
    expect(progress).not.toContain("entry-1");
    expect(progress).not.toContain("entry-2");
  });
});

// appendMessage + getMessages

describe("appendMessage + getMessages", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("returns empty array for non-existent channel", () => {
    expect(store.getMessages("nonexistent")).toEqual([]);
  });

  test("appends and retrieves messages for a channel", () => {
    const msg = store.appendMessage("general", "agent-1", "hello world");
    expect(msg.channel).toBe("general");
    expect(msg.sender).toBe("agent-1");
    expect(msg.content).toBe("hello world");
    expect(msg.timestamp).toBeTruthy();

    const messages = store.getMessages("general");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("hello world");
  });

  test("filters messages by channel", () => {
    store.appendMessage("chan-a", "agent-1", "message A");
    store.appendMessage("chan-b", "agent-2", "message B");
    const chanA = store.getMessages("chan-a");
    const chanB = store.getMessages("chan-b");
    expect(chanA).toHaveLength(1);
    expect(chanA[0]!.content).toBe("message A");
    expect(chanB).toHaveLength(1);
    expect(chanB[0]!.content).toBe("message B");
  });

  test("filters messages since a timestamp", () => {
    // Use a past timestamp as the cutoff — everything after epoch 0 is "new"
    const pastTs = "2000-01-01T00:00:00.000Z";
    store.appendMessage("chan", "agent-1", "old message");
    store.appendMessage("chan", "agent-2", "new message");
    const messages = store.getMessages("chan", { since: pastTs });
    // Both messages are newer than pastTs, so both should appear
    expect(messages.some((m) => m.content === "new message")).toBe(true);
    expect(messages.some((m) => m.content === "old message")).toBe(true);
  });

  test("messages ordered by timestamp ascending", () => {
    store.appendMessage("chan", "a1", "first");
    store.appendMessage("chan", "a2", "second");
    store.appendMessage("chan", "a3", "third");
    const messages = store.getMessages("chan");
    expect(messages[0]!.content).toBe("first");
    expect(messages[1]!.content).toBe("second");
    expect(messages[2]!.content).toBe("third");
  });
});

// postWaveEvent + getWaveEvents + updateWaveEvent lifecycle

describe("wave events lifecycle", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("returns empty array when no wave events", () => {
    expect(store.getWaveEvents()).toEqual([]);
  });

  test("postWaveEvent inserts a pending event", () => {
    store.postWaveEvent({
      id: "evt-1",
      payload: { text: "focus on performance" },
      status: "pending",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "guidance",
    });

    const events = store.getWaveEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("evt-1");
    expect(events[0]!.type).toBe("guidance");
    expect(events[0]!.status).toBe("pending");
    expect(events[0]!.payload).toEqual({ text: "focus on performance" });
  });

  test("getWaveEvents filters by status", () => {
    store.postWaveEvent({
      id: "evt-1",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "guidance",
    });
    store.postWaveEvent({
      id: "evt-2",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:01:00.000Z",
      type: "skip_task",
    });
    store.updateWaveEvent("evt-1", { applied_at: "2026-01-01T00:02:00.000Z", status: "applied" });

    const pending = store.getWaveEvents({ status: "pending" });
    const applied = store.getWaveEvents({ status: "applied" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("evt-2");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.id).toBe("evt-1");
  });

  test("updateWaveEvent — pending to applied", () => {
    store.postWaveEvent({
      id: "evt-1",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "guidance",
    });
    store.updateWaveEvent("evt-1", {
      applied_at: "2026-01-01T01:00:00.000Z",
      resolution: { agents: ["agent-1"] },
      status: "applied",
    });

    const events = store.getWaveEvents({ status: "applied" });
    expect(events).toHaveLength(1);
    expect(events[0]!.applied_at).toBe("2026-01-01T01:00:00.000Z");
    expect(events[0]!.resolution).toEqual({ agents: ["agent-1"] });
  });

  test("updateWaveEvent — pending to rejected", () => {
    store.postWaveEvent({
      id: "evt-1",
      payload: {},
      status: "pending",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "guidance",
    });
    store.updateWaveEvent("evt-1", {
      rejection_reason: "not applicable",
      status: "rejected",
    });

    const events = store.getWaveEvents({ status: "rejected" });
    expect(events).toHaveLength(1);
    expect(events[0]!.rejection_reason).toBe("not applicable");
  });

  test("wave event payload round-trips complex JSON", () => {
    const payload = {
      guidance: "focus on error handling",
      nested: { deep: { value: 42 } },
      target_task_id: "task-01",
    };
    store.postWaveEvent({
      id: "evt-1",
      payload,
      status: "pending",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "inject_context",
    });
    const events = store.getWaveEvents();
    expect(events[0]!.payload).toEqual(payload);
  });
});

// appendEvent

describe("appendEvent", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("writes to events table", () => {
    store.appendEvent("state_entered", {
      state_id: "research",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    store.appendEvent("state_completed", { result: "done", state_id: "research" });

    const db = (store as any).db as Database.Database;
    const rows = db.prepare("SELECT * FROM events ORDER BY id").all() as Array<{
      type: string;
      payload: string;
      timestamp: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.type).toBe("state_entered");
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      state_id: "research",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(rows[1]!.type).toBe("state_completed");
  });

  test("timestamp is set automatically", () => {
    store.appendEvent("test_event", { data: "value" });
    const db = (store as any).db as Database.Database;
    const row = db.prepare("SELECT * FROM events WHERE type = ?").get("test_event") as
      | { timestamp: string }
      | undefined;
    expect(row?.timestamp).toBeTruthy();
    expect(new Date(row!.timestamp).getTime()).toBeGreaterThan(0);
  });
});

// transaction

describe("transaction", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("commits on success", () => {
    store.transaction(() => {
      store.appendProgress("line 1");
      store.appendProgress("line 2");
    });
    const progress = store.getProgress();
    expect(progress).toContain("line 1");
    expect(progress).toContain("line 2");
  });

  test("rolls back on throw", () => {
    try {
      store.transaction(() => {
        store.appendProgress("line 1");
        throw new Error("rollback me");
      });
    } catch {
      // expected
    }
    expect(store.getProgress()).toBe("");
  });
});
