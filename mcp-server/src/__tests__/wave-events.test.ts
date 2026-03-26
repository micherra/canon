import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  eventsPath,
  postWaveEvent,
  readPendingEvents,
  readAllEvents,
  markEventApplied,
  markEventRejected,
  resolveEventAgents,
} from "../orchestration/wave-events.ts";

describe("wave-events", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "canon-wave-events-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe("eventsPath", () => {
    it("returns correct path under waves/events.jsonl", () => {
      const result = eventsPath("/tmp/workspace");
      expect(result).toBe("/tmp/workspace/waves/events.jsonl");
    });

    it("uses the provided workspace as root", () => {
      const result = eventsPath("/some/other/path");
      expect(result).toBe("/some/other/path/waves/events.jsonl");
    });
  });

  describe("postWaveEvent", () => {
    it("creates directory structure and returns event with id, timestamp, and pending status", async () => {
      const event = await postWaveEvent(workspace, {
        type: "add_task",
        payload: { description: "New task to add" },
      });

      expect(event.id).toBeDefined();
      expect(event.id).toMatch(/^evt/);
      expect(event.timestamp).toBeDefined();
      expect(new Date(event.timestamp).getTime()).not.toBeNaN();
      expect(event.status).toBe("pending");
      expect(event.type).toBe("add_task");
      expect(event.payload.description).toBe("New task to add");
    });

    it("writes to events.jsonl at the correct path", async () => {
      await postWaveEvent(workspace, {
        type: "guidance",
        payload: { context: "Use functional patterns" },
      });

      const filePath = eventsPath(workspace);
      const { readFile } = await import("fs/promises");
      const content = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(content.trim());

      expect(parsed.type).toBe("guidance");
      expect(parsed.status).toBe("pending");
    });

    it("appends multiple events so they can all be read back", async () => {
      await postWaveEvent(workspace, {
        type: "add_task",
        payload: { description: "First task" },
      });

      await postWaveEvent(workspace, {
        type: "skip_task",
        payload: { task_id: "task-01" },
      });

      await postWaveEvent(workspace, {
        type: "pause",
        payload: {},
      });

      const events = await readAllEvents(workspace);
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("add_task");
      expect(events[1].type).toBe("skip_task");
      expect(events[2].type).toBe("pause");
    });

    it("preserves payload fields on the returned event", async () => {
      const event = await postWaveEvent(workspace, {
        type: "reprioritize",
        payload: { task_id: "task-03", wave: 2 },
      });

      expect(event.payload.task_id).toBe("task-03");
      expect(event.payload.wave).toBe(2);
    });
  });

  describe("readPendingEvents", () => {
    it("returns empty array when events file does not exist", async () => {
      const events = await readPendingEvents(workspace);
      expect(events).toEqual([]);
    });

    it("returns only pending events, filtering out applied and rejected", async () => {
      const evt1 = await postWaveEvent(workspace, {
        type: "add_task",
        payload: { description: "Task A" },
      });
      const evt2 = await postWaveEvent(workspace, {
        type: "guidance",
        payload: { context: "Some guidance" },
      });
      const evt3 = await postWaveEvent(workspace, {
        type: "pause",
        payload: {},
      });

      await markEventApplied(workspace, evt1.id);
      await markEventRejected(workspace, evt2.id, "Not relevant");

      const pending = await readPendingEvents(workspace);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(evt3.id);
      expect(pending[0].status).toBe("pending");
    });

    it("returns all events when none have been applied or rejected", async () => {
      await postWaveEvent(workspace, { type: "add_task", payload: { description: "A" } });
      await postWaveEvent(workspace, { type: "skip_task", payload: { task_id: "t1" } });

      const pending = await readPendingEvents(workspace);
      expect(pending).toHaveLength(2);
    });
  });

  describe("readAllEvents", () => {
    it("returns empty array when events file does not exist", async () => {
      const events = await readAllEvents(workspace);
      expect(events).toEqual([]);
    });

    it("returns all events regardless of status", async () => {
      const evt1 = await postWaveEvent(workspace, {
        type: "add_task",
        payload: { description: "Task" },
      });
      const evt2 = await postWaveEvent(workspace, {
        type: "inject_context",
        payload: { context: "Context data" },
      });

      await markEventApplied(workspace, evt1.id);

      const all = await readAllEvents(workspace);
      expect(all).toHaveLength(2);

      const statuses = all.map((e) => e.status);
      expect(statuses).toContain("applied");
      expect(statuses).toContain("pending");
    });

    it("skips corrupt JSONL lines without throwing", async () => {
      const filePath = eventsPath(workspace);
      await mkdir(join(workspace, "waves"), { recursive: true });

      const validEvent = await postWaveEvent(workspace, {
        type: "pause",
        payload: {},
      });

      // Inject a corrupt line directly into the file
      const { appendFile } = await import("fs/promises");
      await appendFile(filePath, "this is not valid json\n", "utf-8");

      await postWaveEvent(workspace, {
        type: "guidance",
        payload: { context: "After corrupt line" },
      });

      const events = await readAllEvents(workspace);
      // Should have the 2 valid events, skipping the corrupt line
      expect(events).toHaveLength(2);
      expect(events[0].id).toBe(validEvent.id);
      expect(events[1].type).toBe("guidance");
    });
  });

  describe("markEventApplied", () => {
    it("sets status to applied and sets applied_at", async () => {
      const before = new Date().toISOString();
      const evt = await postWaveEvent(workspace, {
        type: "add_task",
        payload: { description: "Apply me" },
      });

      await markEventApplied(workspace, evt.id);

      const events = await readAllEvents(workspace);
      const updated = events.find((e) => e.id === evt.id)!;
      expect(updated.status).toBe("applied");
      expect(updated.applied_at).toBeDefined();
      expect(new Date(updated.applied_at!).getTime()).not.toBeNaN();
      expect(updated.applied_at! >= before).toBe(true);
    });

    it("attaches resolution when provided", async () => {
      const evt = await postWaveEvent(workspace, {
        type: "add_task",
        payload: { description: "Task with resolution" },
      });

      const resolution = {
        agents_spawned: ["canon-architect"],
        artifacts: ["plans/task-04.md"],
        summary: "Task planned and slotted",
      };

      await markEventApplied(workspace, evt.id, resolution);

      const events = await readAllEvents(workspace);
      const updated = events.find((e) => e.id === evt.id)!;
      expect(updated.status).toBe("applied");
      expect(updated.resolution).toEqual(resolution);
    });

    it("does not attach resolution field when not provided", async () => {
      const evt = await postWaveEvent(workspace, {
        type: "skip_task",
        payload: { task_id: "t1" },
      });

      await markEventApplied(workspace, evt.id);

      const events = await readAllEvents(workspace);
      const updated = events.find((e) => e.id === evt.id)!;
      expect(updated.status).toBe("applied");
      expect(updated.resolution).toBeUndefined();
    });

    it("does not modify other events in the file", async () => {
      const evt1 = await postWaveEvent(workspace, {
        type: "add_task",
        payload: { description: "Target" },
      });
      const evt2 = await postWaveEvent(workspace, {
        type: "pause",
        payload: {},
      });

      await markEventApplied(workspace, evt1.id);

      const events = await readAllEvents(workspace);
      const untouched = events.find((e) => e.id === evt2.id)!;
      expect(untouched.status).toBe("pending");
    });
  });

  describe("markEventRejected", () => {
    it("sets status to rejected and sets rejection_reason", async () => {
      const evt = await postWaveEvent(workspace, {
        type: "add_task",
        payload: { description: "Reject me" },
      });

      await markEventRejected(workspace, evt.id, "Out of scope for this wave");

      const events = await readAllEvents(workspace);
      const updated = events.find((e) => e.id === evt.id)!;
      expect(updated.status).toBe("rejected");
      expect(updated.rejection_reason).toBe("Out of scope for this wave");
    });

    it("does not modify other events in the file", async () => {
      const evt1 = await postWaveEvent(workspace, {
        type: "guidance",
        payload: { context: "Reject this one" },
      });
      const evt2 = await postWaveEvent(workspace, {
        type: "inject_context",
        payload: { context: "Keep this one" },
      });

      await markEventRejected(workspace, evt1.id, "Irrelevant");

      const events = await readAllEvents(workspace);
      const untouched = events.find((e) => e.id === evt2.id)!;
      expect(untouched.status).toBe("pending");
    });
  });

  describe("resolveEventAgents", () => {
    it("add_task returns canon-architect", () => {
      const result = resolveEventAgents("add_task");
      expect(result.agents).toEqual(["canon-architect"]);
      expect(result.descriptions["canon-architect"]).toBeDefined();
    });

    it("skip_task returns no agents", () => {
      const result = resolveEventAgents("skip_task");
      expect(result.agents).toEqual([]);
      expect(result.descriptions).toEqual({});
    });

    it("reprioritize returns canon-architect", () => {
      const result = resolveEventAgents("reprioritize");
      expect(result.agents).toEqual(["canon-architect"]);
      expect(result.descriptions["canon-architect"]).toBeDefined();
    });

    it("inject_context returns no agents", () => {
      const result = resolveEventAgents("inject_context");
      expect(result.agents).toEqual([]);
      expect(result.descriptions).toEqual({});
    });

    it("guidance returns no agents (mechanical orchestrator operation)", () => {
      const result = resolveEventAgents("guidance");
      expect(result.agents).toEqual([]);
      expect(result.descriptions).toEqual({});
    });

    it("pause returns no agents", () => {
      const result = resolveEventAgents("pause");
      expect(result.agents).toEqual([]);
      expect(result.descriptions).toEqual({});
    });
  });
});
