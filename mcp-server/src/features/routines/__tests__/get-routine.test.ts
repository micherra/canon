import type { Routine } from "@shared/routine.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRoutine } from "../tools/get-routine.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    body: "Routine body text describing what it does.",
    filePath: "/plugin/routines/test-routine.md",
    guardrails: { consent: "opt-in", mutates_running_build: false, repo_writes: "none" },
    name: "test-routine",
    needs: { daemon: false, state: "git-native" },
    recurrence: "standing",
    repos: ["myorg/myrepo"],
    scope: "repo",
    source: "plugin",
    status: "enabled",
    title: "Test Routine",
    trigger: { kind: "schedule", cron: "0 9 * * 1" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock seams
// ---------------------------------------------------------------------------

vi.mock("@shared/routine.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/routine.ts")>();
  return {
    ...actual,
    loadAllRoutines: vi.fn(),
  };
});

vi.mock("../services/routine-state.ts", () => ({
  readRoutineState: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getRoutine", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    // Re-apply default for readRoutineState after resetAllMocks clears it
    const { readRoutineState } = await import("../services/routine-state.ts");
    vi.mocked(readRoutineState).mockResolvedValue(null);
  });
  it("happy path: returns the full routine with binding, drift, and state", async () => {
    const { loadAllRoutines } = await import("@shared/routine.ts");
    vi.mocked(loadAllRoutines).mockResolvedValueOnce([
      makeRoutine({ name: "test-routine", status: "enabled" }),
    ]);

    const env = {
      existsSync: () => false,
      hasCloudRecipeMarker: () => true,
      homeDir: "/home/test",
    };

    const result = await getRoutine({ name: "test-routine" }, "/project", "/plugin", env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.name).toBe("test-routine");
    expect(result.title).toBe("Test Routine");
    expect(result.status).toBe("enabled");
    expect(result.body).toBe("Routine body text describing what it does.");
    expect(result.resolved_binding.target).toBe("cloud-routine");
    expect(result.drift).toBe("bound");
    expect(result.state).toBeNull();
    expect(result.trigger).toEqual({ cron: "0 9 * * 1", kind: "schedule" });
    expect(result.repos).toEqual(["myorg/myrepo"]);
  });

  it("returns INVALID_INPUT error when name is empty", async () => {
    const { loadAllRoutines } = await import("@shared/routine.ts");
    vi.mocked(loadAllRoutines).mockResolvedValueOnce([makeRoutine()]);

    const env = { existsSync: () => false, homeDir: "/home/test" };
    const result = await getRoutine({ name: "" }, "/project", "/plugin", env);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT error when routine name is not found", async () => {
    const { loadAllRoutines } = await import("@shared/routine.ts");
    vi.mocked(loadAllRoutines).mockResolvedValueOnce([makeRoutine({ name: "other-routine" })]);

    const env = { existsSync: () => false, homeDir: "/home/test" };
    const result = await getRoutine({ name: "missing-routine" }, "/project", "/plugin", env);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
    expect(result.message).toContain("missing-routine");
  });

  it("includes state when state file exists", async () => {
    const { loadAllRoutines } = await import("@shared/routine.ts");
    vi.mocked(loadAllRoutines).mockResolvedValueOnce([
      makeRoutine({ name: "routine-with-history" }),
    ]);

    const { readRoutineState } = await import("../services/routine-state.ts");
    vi.mocked(readRoutineState).mockResolvedValueOnce({
      last_outcome: "success",
      last_run: "2026-06-08T10:00:00Z",
    });

    const env = { existsSync: () => false, homeDir: "/home/test" };
    const result = await getRoutine({ name: "routine-with-history" }, "/project", "/plugin", env);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toEqual({ last_outcome: "success", last_run: "2026-06-08T10:00:00Z" });
  });

  it("returns drift 'unbound' for desktop-task with no SKILL.md", async () => {
    const { loadAllRoutines } = await import("@shared/routine.ts");
    vi.mocked(loadAllRoutines).mockResolvedValueOnce([
      makeRoutine({ name: "desktop-routine", needs: { daemon: true, state: "local-canon" } }),
    ]);

    const env = { existsSync: () => false, homeDir: "/home/test" };
    const result = await getRoutine({ name: "desktop-routine" }, "/project", "/plugin", env);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drift).toBe("unbound");
    expect(result.resolved_binding.target).toBe("desktop-task");
  });
});
