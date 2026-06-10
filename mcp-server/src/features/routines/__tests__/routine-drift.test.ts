import type { Routine } from "@shared/routine.ts";
import { describe, expect, it } from "vitest";
import type { RoutineEnv } from "../services/routine-drift.ts";
import { computeBindingDrift, findOrphans } from "../services/routine-drift.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    body: "",
    filePath: "/plugin/routines/test.md",
    guardrails: { consent: "opt-in", mutates_running_build: false, repo_writes: "none" },
    name: "test-routine",
    needs: { daemon: false, state: "git-native" },
    recurrence: "standing",
    repos: [],
    scope: "repo",
    source: "plugin",
    status: "enabled",
    title: "Test Routine",
    trigger: { kind: "schedule" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeBindingDrift — desktop-task (binding_target === "desktop-task")
// ---------------------------------------------------------------------------

describe("computeBindingDrift: desktop-task routines", () => {
  it("returns 'bound' when SKILL.md exists for the routine", () => {
    const routine = makeRoutine({
      needs: { daemon: true, state: "local-canon" },
    });
    const env: RoutineEnv = {
      existsSync: (p) => p.includes(`test-routine/SKILL.md`),
      homeDir: "/home/user",
    };
    expect(computeBindingDrift(routine, env)).toBe("bound");
  });

  it("returns 'unbound' when SKILL.md does not exist for an enabled routine", () => {
    const routine = makeRoutine({
      needs: { daemon: true, state: "local-canon" },
    });
    const env: RoutineEnv = {
      existsSync: () => false, // no SKILL.md
      homeDir: "/home/user",
    };
    expect(computeBindingDrift(routine, env)).toBe("unbound");
  });

  it("returns 'unbound' for disabled routine with no SKILL.md", () => {
    const routine = makeRoutine({
      needs: { daemon: true, state: "local-canon" },
      status: "disabled",
    });
    const env: RoutineEnv = {
      existsSync: () => false,
      homeDir: "/home/user",
    };
    expect(computeBindingDrift(routine, env)).toBe("unbound");
  });

  it("returns 'bound' for disabled routine with SKILL.md present", () => {
    const routine = makeRoutine({
      needs: { daemon: true, state: "local-canon" },
      status: "disabled",
    });
    const env: RoutineEnv = {
      existsSync: (p) => p.includes("test-routine/SKILL.md"),
      homeDir: "/home/user",
    };
    expect(computeBindingDrift(routine, env)).toBe("bound");
  });
});

// ---------------------------------------------------------------------------
// computeBindingDrift — cloud-routine (binding_target === "cloud-routine")
// ---------------------------------------------------------------------------

describe("computeBindingDrift: cloud-routine routines", () => {
  it("returns 'bound' when cloud recipe marker returns true", () => {
    const routine = makeRoutine({
      needs: { daemon: false, state: "git-native" },
    });
    const env: RoutineEnv = {
      existsSync: () => false, // SKILL.md irrelevant for cloud
      hasCloudRecipeMarker: () => true,
      homeDir: "/home/user",
    };
    expect(computeBindingDrift(routine, env)).toBe("bound");
  });

  it("returns 'unbound' when cloud recipe marker returns false", () => {
    const routine = makeRoutine({
      needs: { daemon: false, state: "git-native" },
    });
    const env: RoutineEnv = {
      existsSync: () => false,
      hasCloudRecipeMarker: () => false,
      homeDir: "/home/user",
    };
    expect(computeBindingDrift(routine, env)).toBe("unbound");
  });

  it("returns 'unbound' when hasCloudRecipeMarker is not provided (fail-open)", () => {
    const routine = makeRoutine({
      needs: { daemon: false, state: "git-native" },
    });
    const env: RoutineEnv = {
      existsSync: () => false,
      homeDir: "/home/user",
      // hasCloudRecipeMarker not provided
    };
    expect(computeBindingDrift(routine, env)).toBe("unbound");
  });
});

// ---------------------------------------------------------------------------
// computeBindingDrift — never touches real ~/.claude
// ---------------------------------------------------------------------------

describe("computeBindingDrift: does not read real homeDir", () => {
  it("uses injected homeDir, not process.env.HOME", () => {
    const routine = makeRoutine({
      needs: { daemon: true, state: "local-canon" },
    });

    const pathsChecked: string[] = [];
    const env: RoutineEnv = {
      existsSync: (p) => {
        pathsChecked.push(p);
        return false;
      },
      homeDir: "/fake/home",
    };

    computeBindingDrift(routine, env);

    // All checked paths must use the injected homeDir, never a real home dir
    for (const p of pathsChecked) {
      expect(p).toMatch(/^\/fake\/home/);
    }
  });
});

// ---------------------------------------------------------------------------
// findOrphans — live bindings with no backing routine
// ---------------------------------------------------------------------------

describe("findOrphans", () => {
  it("returns empty array when no orphans exist", () => {
    const routine = makeRoutine({ needs: { daemon: true, state: "local-canon" } });
    const env: RoutineEnv = {
      existsSync: () => false,
      homeDir: "/home/user",
      listScheduledTasks: () => [],
    };
    expect(findOrphans([routine], env)).toEqual([]);
  });

  it("returns orphan names for SKILL.md entries with no backing routine", () => {
    const routine = makeRoutine({
      name: "known-routine",
      needs: { daemon: true, state: "local-canon" },
    });
    const env: RoutineEnv = {
      existsSync: () => false,
      homeDir: "/home/user",
      listScheduledTasks: () => ["known-routine", "orphaned-routine"],
    };
    const orphans = findOrphans([routine], env);
    expect(orphans).toEqual(["orphaned-routine"]);
  });

  it("returns empty array when listScheduledTasks is not provided", () => {
    const routine = makeRoutine();
    const env: RoutineEnv = {
      existsSync: () => false,
      homeDir: "/home/user",
      // listScheduledTasks not provided
    };
    expect(findOrphans([routine], env)).toEqual([]);
  });

  it("returns all live tasks not in routines as orphans", () => {
    const routines = [makeRoutine({ name: "routine-a" }), makeRoutine({ name: "routine-b" })];
    const env: RoutineEnv = {
      existsSync: () => false,
      homeDir: "/home/user",
      listScheduledTasks: () => ["routine-a", "routine-b", "zombie-1", "zombie-2"],
    };
    const orphans = findOrphans(routines, env);
    expect(orphans).toContain("zombie-1");
    expect(orphans).toContain("zombie-2");
    expect(orphans).toHaveLength(2);
  });
});
