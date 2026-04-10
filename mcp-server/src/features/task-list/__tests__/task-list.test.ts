import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseTaskFile,
  readTaskList,
  readTasksByStatus,
  resolveTaskListPath,
  summarizeTaskList,
} from "../index.ts";

describe("resolveTaskListPath", () => {
  it("defaults to ~/.claude/tasks/<id>", () => {
    const path = resolveTaskListPath("abc");
    expect(path).toMatch(/\.claude\/tasks\/abc$/);
  });

  it("respects an explicit tasks_root override", () => {
    const path = resolveTaskListPath("abc", "/tmp/fake");
    expect(path).toBe("/tmp/fake/abc");
  });
});

describe("parseTaskFile", () => {
  const SOURCE = "/tmp/tasks/sample.json";

  it("returns null on empty input", () => {
    expect(parseTaskFile("", SOURCE)).toBeNull();
    expect(parseTaskFile("   \n  ", SOURCE)).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(parseTaskFile("not json {", SOURCE)).toBeNull();
  });

  it("returns null on non-object JSON", () => {
    expect(parseTaskFile("42", SOURCE)).toBeNull();
    expect(parseTaskFile('"string"', SOURCE)).toBeNull();
    expect(parseTaskFile("null", SOURCE)).toBeNull();
  });

  it("parses the standard fields", () => {
    const record = parseTaskFile(
      JSON.stringify({
        id: "task-1",
        status: "in_progress",
        content: "Write the spawn module",
        active_form: "Writing the spawn module",
      }),
      SOURCE,
    );
    expect(record).toEqual({
      id: "task-1",
      status: "in_progress",
      content: "Write the spawn module",
      active_form: "Writing the spawn module",
      metadata: undefined,
    });
  });

  it("falls back to the filename stem when id is missing", () => {
    const record = parseTaskFile(
      JSON.stringify({ status: "pending", content: "X" }),
      SOURCE,
    );
    expect(record?.id).toBe("sample");
  });

  it("accepts task_id as an alternative id field", () => {
    const record = parseTaskFile(
      JSON.stringify({ task_id: "foo", status: "pending", content: "x" }),
      SOURCE,
    );
    expect(record?.id).toBe("foo");
  });

  it("defaults status to unknown when missing", () => {
    const record = parseTaskFile(
      JSON.stringify({ id: "foo", content: "x" }),
      SOURCE,
    );
    expect(record?.status).toBe("unknown");
  });

  it("accepts camelCase activeForm", () => {
    const record = parseTaskFile(
      JSON.stringify({
        id: "t",
        status: "pending",
        content: "c",
        activeForm: "Doing it",
      }),
      SOURCE,
    );
    expect(record?.active_form).toBe("Doing it");
  });

  it("preserves unknown fields as metadata", () => {
    const record = parseTaskFile(
      JSON.stringify({
        id: "t",
        status: "done",
        content: "c",
        artifact: "plans/SUMMARY.md",
        workflow: "fast-path",
      }),
      SOURCE,
    );
    expect(record?.metadata).toEqual({
      artifact: "plans/SUMMARY.md",
      workflow: "fast-path",
    });
  });
});

describe("readTaskList", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "canon-task-list-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns an empty shell when CLAUDE_CODE_TASK_LIST_ID is unset", () => {
    const prev = process.env.CLAUDE_CODE_TASK_LIST_ID;
    delete process.env.CLAUDE_CODE_TASK_LIST_ID;
    try {
      const result = readTaskList({ tasks_root: tmp });
      expect(result.exists).toBe(false);
      expect(result.tasks).toEqual([]);
      expect(result.warnings[0]).toContain("CLAUDE_CODE_TASK_LIST_ID");
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CODE_TASK_LIST_ID = prev;
    }
  });

  it("returns exists=false when the task list directory is missing", () => {
    const result = readTaskList({
      task_list_id: "does-not-exist",
      tasks_root: tmp,
    });
    expect(result.exists).toBe(false);
    expect(result.tasks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("reads JSON task files and skips non-JSON entries", async () => {
    const listDir = join(tmp, "ws-phase-1");
    await mkdir(listDir, { recursive: true });
    await writeFile(
      join(listDir, "a.json"),
      JSON.stringify({ id: "a", status: "pending", content: "A" }),
    );
    await writeFile(
      join(listDir, "b.json"),
      JSON.stringify({ id: "b", status: "in_progress", content: "B" }),
    );
    await writeFile(join(listDir, "readme.md"), "not json");

    const result = readTaskList({
      task_list_id: "ws-phase-1",
      tasks_root: tmp,
    });
    expect(result.exists).toBe(true);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(result.warnings).toEqual([]);
  });

  it("sorts tasks by id", async () => {
    const listDir = join(tmp, "ws");
    await mkdir(listDir, { recursive: true });
    await writeFile(
      join(listDir, "one.json"),
      JSON.stringify({ id: "c", status: "pending", content: "" }),
    );
    await writeFile(
      join(listDir, "two.json"),
      JSON.stringify({ id: "a", status: "pending", content: "" }),
    );
    await writeFile(
      join(listDir, "three.json"),
      JSON.stringify({ id: "b", status: "pending", content: "" }),
    );

    const result = readTaskList({ task_list_id: "ws", tasks_root: tmp });
    expect(result.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("captures malformed files as warnings but still returns readable ones", async () => {
    const listDir = join(tmp, "ws");
    await mkdir(listDir, { recursive: true });
    await writeFile(
      join(listDir, "ok.json"),
      JSON.stringify({ id: "ok", status: "done", content: "" }),
    );
    await writeFile(join(listDir, "broken.json"), "{ not valid");

    const result = readTaskList({ task_list_id: "ws", tasks_root: tmp });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe("ok");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("broken.json");
  });

  it("populates mtime_ms and source_path on every record", async () => {
    const listDir = join(tmp, "ws");
    await mkdir(listDir, { recursive: true });
    const taskPath = join(listDir, "only.json");
    await writeFile(
      taskPath,
      JSON.stringify({ id: "only", status: "pending", content: "" }),
    );

    const result = readTaskList({ task_list_id: "ws", tasks_root: tmp });
    expect(result.tasks[0]!.source_path).toBe(taskPath);
    expect(result.tasks[0]!.mtime_ms).toBeGreaterThan(0);
  });
});

describe("readTasksByStatus", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "canon-task-list-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("filters tasks by status", async () => {
    const listDir = join(tmp, "ws");
    await mkdir(listDir, { recursive: true });
    await writeFile(
      join(listDir, "a.json"),
      JSON.stringify({ id: "a", status: "pending", content: "" }),
    );
    await writeFile(
      join(listDir, "b.json"),
      JSON.stringify({ id: "b", status: "done", content: "" }),
    );
    await writeFile(
      join(listDir, "c.json"),
      JSON.stringify({ id: "c", status: "pending", content: "" }),
    );

    const pending = readTasksByStatus("pending", {
      task_list_id: "ws",
      tasks_root: tmp,
    });
    expect(pending.map((t) => t.id)).toEqual(["a", "c"]);
  });
});

describe("summarizeTaskList", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "canon-task-list-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("counts tasks per status", async () => {
    const listDir = join(tmp, "ws");
    await mkdir(listDir, { recursive: true });
    await writeFile(
      join(listDir, "a.json"),
      JSON.stringify({ id: "a", status: "pending", content: "" }),
    );
    await writeFile(
      join(listDir, "b.json"),
      JSON.stringify({ id: "b", status: "pending", content: "" }),
    );
    await writeFile(
      join(listDir, "c.json"),
      JSON.stringify({ id: "c", status: "in_progress", content: "" }),
    );
    await writeFile(
      join(listDir, "d.json"),
      JSON.stringify({ id: "d", status: "completed", content: "" }),
    );

    const summary = summarizeTaskList({
      task_list_id: "ws",
      tasks_root: tmp,
    });
    expect(summary.total).toBe(4);
    expect(summary.by_status).toEqual({
      pending: 2,
      in_progress: 1,
      completed: 1,
    });
    expect(summary.path).toContain("/ws");
  });

  it("returns zero counts for a missing list", () => {
    const summary = summarizeTaskList({
      task_list_id: "nope",
      tasks_root: tmp,
    });
    expect(summary.total).toBe(0);
    expect(summary.by_status).toEqual({});
  });
});
