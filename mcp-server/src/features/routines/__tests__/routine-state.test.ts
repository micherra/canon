import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRoutineState, writeRoutineState } from "../services/routine-state.ts";

const CANON_DIR = ".canon";
const ROUTINES_STATE_DIR = "routines-state";

describe("readRoutineState", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = join(tmpdir(), `routine-state-test-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns null when the state file does not exist (ENOENT — fail-open)", async () => {
    const result = await readRoutineState(projectDir, "my-routine");
    expect(result).toBeNull();
  });

  it("returns null when the routines-state dir does not exist (fail-open)", async () => {
    const result = await readRoutineState(projectDir, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns the parsed state when the file exists", async () => {
    const stateDir = join(projectDir, CANON_DIR, ROUTINES_STATE_DIR);
    await mkdir(stateDir, { recursive: true });
    const state = { last_outcome: "success", last_run: "2026-06-08T10:00:00Z" };
    await writeFile(join(stateDir, "my-routine.json"), JSON.stringify(state), "utf-8");

    const result = await readRoutineState(projectDir, "my-routine");
    expect(result).toEqual(state);
  });

  it("returns null for invalid JSON (fail-open, no throw)", async () => {
    const stateDir = join(projectDir, CANON_DIR, ROUTINES_STATE_DIR);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "bad-routine.json"), "{ not valid json", "utf-8");

    const result = await readRoutineState(projectDir, "bad-routine");
    expect(result).toBeNull();
  });

  it("preserves free-form marker fields", async () => {
    const stateDir = join(projectDir, CANON_DIR, ROUTINES_STATE_DIR);
    await mkdir(stateDir, { recursive: true });
    const state = {
      custom_marker: "some-value",
      last_outcome: "failure",
      last_run: "2026-06-07T08:00:00Z",
      run_count: 5,
    };
    await writeFile(join(stateDir, "advanced-routine.json"), JSON.stringify(state), "utf-8");

    const result = await readRoutineState(projectDir, "advanced-routine");
    expect(result).toEqual(state);
    expect((result as Record<string, unknown>)?.run_count).toBe(5);
  });
});

describe("writeRoutineState", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = join(tmpdir(), `routine-state-write-test-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("creates the state file and returns readable state", async () => {
    const state = { last_outcome: "success", last_run: "2026-06-08T12:00:00Z" };
    await writeRoutineState(projectDir, "test-routine", state);

    const result = await readRoutineState(projectDir, "test-routine");
    expect(result).toEqual(state);
  });

  it("creates the directory structure if it does not exist", async () => {
    // No .canon/ dir exists yet
    const state = { last_run: "2026-06-08T00:00:00Z" };
    await writeRoutineState(projectDir, "new-routine", state);

    const filePath = join(projectDir, CANON_DIR, ROUTINES_STATE_DIR, "new-routine.json");
    const raw = await readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual(state);
  });

  it("overwrites an existing state file", async () => {
    const initial = { last_run: "2026-06-01T00:00:00Z" };
    await writeRoutineState(projectDir, "my-routine", initial);

    const updated = { last_outcome: "success", last_run: "2026-06-08T00:00:00Z" };
    await writeRoutineState(projectDir, "my-routine", updated);

    const result = await readRoutineState(projectDir, "my-routine");
    expect(result).toEqual(updated);
  });
});
