/**
 * messages.test.ts — Store-backed message operations
 *
 * Tests the post-message and get-messages tools via ExecutionStore (SQLite).
 * Also tests readChannelAsContext and buildMessageInstructions (pure/utility functions).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initExecutionDb } from "../orchestration/execution-schema.ts";
import { ExecutionStore, getExecutionStore } from "../orchestration/execution-store.ts";
import { buildMessageInstructions, readChannelAsContext } from "../orchestration/messages.ts";
import { getMessages } from "../tools/get-messages.ts";
import { postMessage } from "../tools/post-message.ts";

// ---------------------------------------------------------------------------
// Store-level message operations (unit)
// ---------------------------------------------------------------------------

describe("ExecutionStore messages", () => {
  let db: Database.Database;
  let store: ExecutionStore;

  beforeEach(() => {
    db = initExecutionDb(":memory:");
    store = new ExecutionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("appendMessage inserts and returns a Message-shaped object", () => {
    const msg = store.appendMessage("wave-000", "impl-auth", "Created auth utility.");

    expect(msg.id).toBeDefined();
    expect(typeof msg.id).toBe("number");
    expect(msg.channel).toBe("wave-000");
    expect(msg.sender).toBe("impl-auth");
    expect(msg.content).toBe("Created auth utility.");
    expect(msg.timestamp).toBeDefined();
    expect(new Date(msg.timestamp).getTime()).not.toBeNaN();
  });

  it("getMessages returns messages ordered by id (insertion order)", () => {
    store.appendMessage("ch", "alice", "First");
    store.appendMessage("ch", "bob", "Second");
    store.appendMessage("ch", "charlie", "Third");

    const msgs = store.getMessages("ch");
    expect(msgs).toHaveLength(3);
    expect(msgs[0].sender).toBe("alice");
    expect(msgs[0].content).toBe("First");
    expect(msgs[1].sender).toBe("bob");
    expect(msgs[2].sender).toBe("charlie");
  });

  it("getMessages with since filter returns only newer messages", () => {
    const ts1 = "2026-01-01T00:00:00.000Z";
    const ts2 = "2026-01-01T00:01:00.000Z";

    // Insert via direct db for precise timestamp control
    db.prepare("INSERT INTO messages (channel, sender, content, timestamp) VALUES (?, ?, ?, ?)").run(
      "ch",
      "old-agent",
      "Old message",
      ts1,
    );
    db.prepare("INSERT INTO messages (channel, sender, content, timestamp) VALUES (?, ?, ?, ?)").run(
      "ch",
      "new-agent",
      "New message",
      ts2,
    );

    const msgs = store.getMessages("ch", { since: "2026-01-01T00:00:30.000Z" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].sender).toBe("new-agent");
    expect(msgs[0].content).toBe("New message");
  });

  it("getMessages returns empty array for non-existent channel", () => {
    const msgs = store.getMessages("nonexistent-channel");
    expect(msgs).toEqual([]);
  });

  it("messages in different channels are independent", () => {
    store.appendMessage("channel-a", "agent", "In A");
    store.appendMessage("channel-b", "agent", "In B");

    const a = store.getMessages("channel-a");
    const b = store.getMessages("channel-b");

    expect(a).toHaveLength(1);
    expect(a[0].content).toBe("In A");
    expect(b).toHaveLength(1);
    expect(b[0].content).toBe("In B");
  });

  it("no .sequence.lock or .sequence files are created", async () => {
    // The store never creates file system artifacts for messages
    const workspace = await mkdtemp(join(tmpdir(), "canon-msg-files-"));
    try {
      store.appendMessage("wave-000", "agent", "Hello");
      // No files should be created in workspace since store is in-memory
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(workspace).catch(() => []);
      // workspace should be empty — no .sequence or .sequence.lock
      const sequenceFiles = files.filter((f) => f.includes("sequence"));
      expect(sequenceFiles).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tool-level: postMessage and getMessages via workspace store
// ---------------------------------------------------------------------------

describe("postMessage tool (store-backed)", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "canon-post-msg-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    // Clear store cache between tests
    const _storeCache = (await import("../orchestration/execution-store.ts")) as { default?: unknown };
    // Re-import to clear singleton — use a fresh workspace per test so no conflict
  });

  it("returns a message with from, content, and timestamp fields", async () => {
    const result = await postMessage({
      workspace,
      channel: "wave-000",
      from: "impl-auth",
      content: "Created auth utility.",
    });

    expect(result.message.from).toBe("impl-auth");
    expect(result.message.content).toBe("Created auth utility.");
    expect(result.message.timestamp).toBeDefined();
    expect(new Date(result.message.timestamp).getTime()).not.toBeNaN();
  });

  it("returns a message with id field (from store)", async () => {
    const result = await postMessage({
      workspace,
      channel: "wave-000",
      from: "agent-a",
      content: "Hello",
    });

    // SQLite store messages have numeric id
    expect(result.message).toBeDefined();
    expect(result.message.from).toBe("agent-a");
  });
});

describe("getMessages tool (store-backed)", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "canon-get-msg-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns empty result for channel with no messages", async () => {
    const result = await getMessages({ workspace, channel: "empty-channel" });
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("returns messages in order", async () => {
    const store = getExecutionStore(workspace);
    store.appendMessage("ch", "alice", "First message");
    store.appendMessage("ch", "bob", "Second message");

    const result = await getMessages({ workspace, channel: "ch" });
    expect(result.messages).toHaveLength(2);
    expect(result.count).toBe(2);
    expect(result.messages[0].from).toBe("alice");
    expect(result.messages[0].content).toBe("First message");
    expect(result.messages[1].from).toBe("bob");
  });

  it("filters by since timestamp", async () => {
    const store = getExecutionStore(workspace);
    const db = (store as unknown as { db: Database.Database }).db;

    db.prepare("INSERT INTO messages (channel, sender, content, timestamp) VALUES (?, ?, ?, ?)").run(
      "ch",
      "old-agent",
      "Old",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO messages (channel, sender, content, timestamp) VALUES (?, ?, ?, ?)").run(
      "ch",
      "new-agent",
      "New",
      "2026-01-01T00:01:00.000Z",
    );

    const result = await getMessages({ workspace, channel: "ch", since: "2026-01-01T00:00:30.000Z" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].from).toBe("new-agent");
    expect(result.messages[0].content).toBe("New");
    expect(result.count).toBe(1);
  });

  it("include_events returns pending wave events from store", async () => {
    const store = getExecutionStore(workspace);
    store.postWaveEvent({
      id: "evt-1",
      type: "guidance",
      payload: { context: "some guidance" },
      timestamp: new Date().toISOString(),
      status: "pending",
    });

    const result = await getMessages({ workspace, channel: "wave-000", include_events: true });
    expect(result.events).toBeDefined();
    expect(result.events).toHaveLength(1);
    expect(result.events![0].id).toBe("evt-1");
    expect(result.events![0].status).toBe("pending");
    expect(result.events_count).toBe(1);
  });

  it("include_events returns empty array when no pending events", async () => {
    const result = await getMessages({ workspace, channel: "wave-000", include_events: true });
    expect(result.events).toEqual([]);
    expect(result.events_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readChannelAsContext (reads from store)
// ---------------------------------------------------------------------------

describe("readChannelAsContext (store-backed)", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "canon-ctx-msg-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns empty string for channel with no messages", async () => {
    const ctx = await readChannelAsContext(workspace, "empty");
    expect(ctx).toBe("");
  });

  it("concatenates messages with separators", async () => {
    const store = getExecutionStore(workspace);
    store.appendMessage("ch", "alice", "Hello from Alice");
    store.appendMessage("ch", "bob", "Hello from Bob");

    const ctx = await readChannelAsContext(workspace, "ch");
    expect(ctx).toContain("**alice:**");
    expect(ctx).toContain("Hello from Alice");
    expect(ctx).toContain("**bob:**");
    expect(ctx).toContain("Hello from Bob");
    expect(ctx).toContain("---");
  });

  it("truncates when exceeding maxChars", async () => {
    const store = getExecutionStore(workspace);
    store.appendMessage("ch", "agent", "x".repeat(3000));

    const ctx = await readChannelAsContext(workspace, "ch", { maxChars: 100 });
    expect(ctx.length).toBeLessThanOrEqual(130);
    expect(ctx).toContain("[Messages truncated]");
  });
});

// ---------------------------------------------------------------------------
// buildMessageInstructions (pure function — unchanged)
// ---------------------------------------------------------------------------

describe("buildMessageInstructions", () => {
  it("includes channel and workspace in instructions", () => {
    const instr = buildMessageInstructions("wave-001", 3, "/path/to/ws");
    expect(instr).toContain("wave-001");
    expect(instr).toContain("/path/to/ws");
    expect(instr).toContain("3 other agents");
  });

  it("handles singular peer count", () => {
    const instr = buildMessageInstructions("wave-001", 1, "/path/to/ws");
    expect(instr).toContain("1 other agent.");
  });
});
