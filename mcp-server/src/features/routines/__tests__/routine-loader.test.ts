import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rawUntrustedForStructuralUse } from "@shared/lib/overlay-untrusted-text.ts";
import {
  loadAllRoutines,
  loadRoutineFile,
  loadRoutinesFromDir,
  parseRoutine,
} from "@shared/routine.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TMP = join(import.meta.dirname, "__tmp__");

async function mkTmpDir(name: string): Promise<string> {
  const dir = join(BASE_TMP, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

const VALID_ROUTINE_CONTENT = `---
name: release-ahead
title: Release-ahead check
status: enabled
trigger:
  kind: schedule
  cron: "0 9 * * *"
needs:
  state: git-native
  daemon: false
repos: [canon]
scope: repo
guardrails:
  mutates_running_build: false
  repo_writes: notify-only
  consent: opt-in
recurrence: standing
---

## Routine: Release-ahead check

### Intent
Check if releases are ahead of origin/main.

### Body
Run the ahead check and notify.
`;

const MALFORMED_ROUTINE_CONTENT = `Not valid frontmatter at all — no YAML delimiters`;

const MISSING_NAME_ROUTINE_CONTENT = `---
title: No name here
status: enabled
trigger:
  kind: schedule
  cron: "0 9 * * *"
needs:
  state: git-native
  daemon: false
repos: []
scope: repo
guardrails:
  mutates_running_build: false
  repo_writes: none
  consent: opt-in
recurrence: standing
---

Body text here.
`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await mkdir(BASE_TMP, { recursive: true });
});

afterEach(async () => {
  await rm(BASE_TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseRoutine
// ---------------------------------------------------------------------------

describe("parseRoutine", () => {
  it("parses a valid routine file correctly", () => {
    const routine = parseRoutine(VALID_ROUTINE_CONTENT, "/routines/release-ahead.md", "plugin");

    expect(routine.name).toBe("release-ahead");
    expect(rawUntrustedForStructuralUse(routine.title)).toBe("Release-ahead check");
    expect(routine.status).toBe("enabled");
    expect(routine.trigger.kind).toBe("schedule");
    expect(routine.trigger.cron).toBe("0 9 * * *");
    expect(routine.needs.state).toBe("git-native");
    expect(routine.needs.daemon).toBe(false);
    expect(routine.repos).toEqual(["canon"]);
    expect(routine.scope).toBe("repo");
    expect(routine.guardrails.mutates_running_build).toBe(false);
    expect(routine.guardrails.repo_writes).toBe("notify-only");
    expect(routine.guardrails.consent).toBe("opt-in");
    expect(routine.recurrence).toBe("standing");
    expect(routine.source).toBe("plugin");
    expect(routine.filePath).toBe("/routines/release-ahead.md");
    expect(rawUntrustedForStructuralUse(routine.body)).toContain("Release-ahead check");
  });

  it("returns name='' for malformed frontmatter (no YAML delimiters)", () => {
    const routine = parseRoutine(MALFORMED_ROUTINE_CONTENT, "/routines/bad.md", "project");
    expect(routine.name).toBe("");
  });

  it("returns name='' when name field is missing from frontmatter", () => {
    const routine = parseRoutine(MISSING_NAME_ROUTINE_CONTENT, "/routines/noname.md", "plugin");
    expect(routine.name).toBe("");
  });

  it("does not throw for any input", () => {
    expect(() => parseRoutine("", "/empty.md", "project")).not.toThrow();
    expect(() => parseRoutine("---\nbad yaml: [[[", "/bad.md", "plugin")).not.toThrow();
    expect(() => parseRoutine("---\nname: x\n---\n", "/min.md", "project")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadRoutineFile
// ---------------------------------------------------------------------------

describe("loadRoutineFile", () => {
  it("loads and parses a valid file", async () => {
    const dir = await mkTmpDir("load-file");
    const filePath = join(dir, "release-ahead.md");
    await writeFile(filePath, VALID_ROUTINE_CONTENT);

    const routine = await loadRoutineFile(filePath, "project");
    expect(routine.name).toBe("release-ahead");
    expect(routine.source).toBe("project");
  });

  it("returns routine with name='' for a missing file (fail-open)", async () => {
    const routine = await loadRoutineFile("/no/such/file.md", "project");
    expect(routine.name).toBe("");
  });
});

// ---------------------------------------------------------------------------
// loadRoutinesFromDir
// ---------------------------------------------------------------------------

describe("loadRoutinesFromDir", () => {
  it("returns [] for a non-existent directory (ENOENT fail-open)", async () => {
    const routines = await loadRoutinesFromDir("/no/such/dir", "plugin");
    expect(routines).toEqual([]);
  });

  it("filters out routines with name='' (malformed files)", async () => {
    const dir = await mkTmpDir("filter-malformed");
    await writeFile(join(dir, "good.md"), VALID_ROUTINE_CONTENT);
    await writeFile(join(dir, "bad.md"), MALFORMED_ROUTINE_CONTENT);

    const routines = await loadRoutinesFromDir(dir, "project");
    expect(routines).toHaveLength(1);
    expect(routines[0].name).toBe("release-ahead");
  });

  it("ignores README.md files", async () => {
    const dir = await mkTmpDir("ignore-readme");
    await writeFile(join(dir, "release-ahead.md"), VALID_ROUTINE_CONTENT);
    await writeFile(join(dir, "README.md"), "# readme");

    const routines = await loadRoutinesFromDir(dir, "project");
    expect(routines).toHaveLength(1);
  });

  it("parses nested objects correctly (trigger, needs, guardrails)", async () => {
    const dir = await mkTmpDir("nested-objects");
    await writeFile(join(dir, "release-ahead.md"), VALID_ROUTINE_CONTENT);

    const routines = await loadRoutinesFromDir(dir, "project");
    expect(routines).toHaveLength(1);
    const r = routines[0];
    expect(r.trigger).toEqual({ kind: "schedule", cron: "0 9 * * *" });
    expect(r.needs).toEqual({ state: "git-native", daemon: false });
    expect(r.guardrails).toEqual({
      mutates_running_build: false,
      repo_writes: "notify-only",
      consent: "opt-in",
    });
  });
});

// ---------------------------------------------------------------------------
// loadAllRoutines — precedence (PRD AC#2)
// ---------------------------------------------------------------------------

describe("loadAllRoutines — precedence", () => {
  it("project-local .canon/routines shadows plugin routines on name conflict", async () => {
    // Set up pluginDir with a routine named "release-ahead" (status: disabled)
    const pluginDir = await mkTmpDir("plugin");
    const pluginRoutinesDir = join(pluginDir, "routines");
    await mkdir(pluginRoutinesDir, { recursive: true });
    const pluginVersion = VALID_ROUTINE_CONTENT.replace("status: enabled", "status: disabled");
    await writeFile(join(pluginRoutinesDir, "release-ahead.md"), pluginVersion);

    // Set up projectDir with .canon/routines/ overriding same name (status: enabled)
    const projectDir = await mkTmpDir("project");
    const projectRoutinesDir = join(projectDir, ".canon", "routines");
    await mkdir(projectRoutinesDir, { recursive: true });
    await writeFile(join(projectRoutinesDir, "release-ahead.md"), VALID_ROUTINE_CONTENT);

    const routines = await loadAllRoutines(projectDir, pluginDir);

    // Only one routine by that name, and it should be the project version (enabled)
    const byName = routines.filter((r) => r.name === "release-ahead");
    expect(byName).toHaveLength(1);
    expect(byName[0].status).toBe("enabled");
    expect(byName[0].source).toBe("project");
  });

  it("plugin routines are included when no project override exists", async () => {
    const pluginDir = await mkTmpDir("plugin-only-plugin");
    const pluginRoutinesDir = join(pluginDir, "routines");
    await mkdir(pluginRoutinesDir, { recursive: true });
    await writeFile(join(pluginRoutinesDir, "release-ahead.md"), VALID_ROUTINE_CONTENT);

    // projectDir exists but has no .canon/routines/
    const projectDir = await mkTmpDir("plugin-only-project");

    const routines = await loadAllRoutines(projectDir, pluginDir);
    expect(routines).toHaveLength(1);
    expect(routines[0].name).toBe("release-ahead");
    expect(routines[0].source).toBe("plugin");
  });

  it("returns [] when both dirs are absent", async () => {
    const routines = await loadAllRoutines("/no/project", "/no/plugin");
    expect(routines).toEqual([]);
  });
});
