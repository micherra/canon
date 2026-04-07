/**
 * Tests for ExecutionStore.getMessagesSinceId (ADR-012 / fe-01)
 *
 * Covers:
 * - Returns empty array when channel has no messages
 * - Returns empty array when sinceId is beyond all messages
 * - Returns only messages with id > sinceId (exclusive)
 * - Returns messages in ascending id order
 * - Scoped by channel — does not return messages from other channels
 * - sinceId = 0 returns all messages in the channel
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

describe("ExecutionStore.getMessagesSinceId", () => {
  let store: ExecutionStore;

  beforeEach(() => {
    store = makeStore();
  });
  afterEach(() => {
    store.close();
  });

  test("returns empty array when channel has no messages", () => {
    const result = store.getMessagesSinceId("empty-chan", 0);
    expect(result).toEqual([]);
  });

  test("returns empty array when sinceId is beyond all inserted ids", () => {
    const msg = store.appendMessage("chan", "agent", "hello");
    const result = store.getMessagesSinceId("chan", msg.id);
    expect(result).toEqual([]);
  });

  test("returns only messages with id > sinceId", () => {
    const m1 = store.appendMessage("chan", "a1", "first");
    const m2 = store.appendMessage("chan", "a2", "second");
    const m3 = store.appendMessage("chan", "a3", "third");

    const result = store.getMessagesSinceId("chan", m1.id);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(m2.id);
    expect(result[1]!.id).toBe(m3.id);
    expect(result[0]!.content).toBe("second");
    expect(result[1]!.content).toBe("third");
  });

  test("returns messages in ascending id order", () => {
    store.appendMessage("chan", "a1", "msg-1");
    store.appendMessage("chan", "a2", "msg-2");
    store.appendMessage("chan", "a3", "msg-3");

    const result = store.getMessagesSinceId("chan", 0);
    expect(result).toHaveLength(3);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.id).toBeGreaterThan(result[i - 1]!.id);
    }
  });

  test("scoped by channel — does not leak other channel messages", () => {
    const mA = store.appendMessage("chan-a", "a1", "message in A");
    store.appendMessage("chan-b", "b1", "message in B");

    const resultA = store.getMessagesSinceId("chan-a", 0);
    expect(resultA).toHaveLength(1);
    expect(resultA[0]!.content).toBe("message in A");

    const resultB = store.getMessagesSinceId("chan-b", mA.id - 1);
    expect(resultB.every((m) => m.channel === "chan-b")).toBe(true);
  });

  test("sinceId = 0 returns all messages in the channel", () => {
    store.appendMessage("chan", "a1", "alpha");
    store.appendMessage("chan", "a2", "beta");

    const result = store.getMessagesSinceId("chan", 0);
    expect(result).toHaveLength(2);
    expect(result[0]!.content).toBe("alpha");
    expect(result[1]!.content).toBe("beta");
  });

  test("returned MessageOutput fields are fully populated", () => {
    const appended = store.appendMessage("chan", "agent-x", "payload content");
    // sinceId = 0 returns everything
    const [msg] = store.getMessagesSinceId("chan", 0);
    expect(msg).toBeDefined();
    expect(msg!.id).toBe(appended.id);
    expect(msg!.channel).toBe("chan");
    expect(msg!.sender).toBe("agent-x");
    expect(msg!.content).toBe("payload content");
    expect(msg!.timestamp).toBeTruthy();
  });
});
