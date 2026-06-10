import type { Routine } from "@shared/routine.ts";
import { describe, expect, it, vi } from "vitest";
import { listRoutines } from "../tools/list-routines.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    body: "Routine body text",
    filePath: "/plugin/routines/test-routine.md",
    guardrails: { consent: "opt-in", mutates_running_build: false, repo_writes: "none" },
    name: "test-routine",
    needs: { daemon: false, state: "git-native" },
    recurrence: "standing",
    repos: [],
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

// Mock loadAllRoutines to avoid filesystem reads
vi.mock("@shared/routine.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/routine.ts")>();
  return {
    ...actual,
    loadAllRoutines: vi.fn(),
  };
});

// Mock readRoutineState to avoid filesystem reads
vi.mock("../services/routine-state.ts", () => ({
  readRoutineState: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listRoutines", () => {
  it("happy path: returns routines with resolved binding, drift, and last_run", async () => {
    const { loadAllRoutines } = await import("@shared/routine.ts");
    vi.mocked(loadAllRoutines).mockResolvedValueOnce([
      makeRoutine({
        name: "cloud-routine-a",
        needs: { daemon: false, state: "git-native" },
        status: "enabled",
      }),
    ]);

    const env = {
      existsSync: () => false,
      hasCloudRecipeMarker: (_name: string) => true,
      homeDir: "/home/test",
    };

    const result = await listRoutines({}, "/project", "/plugin", env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.routines).toHaveLength(1);
    const r = result.routines[0];
    expect(r.name).toBe("cloud-routine-a");
    expect(r.status).toBe("enabled");
    expect(r.resolved_binding.target).toBe("cloud-routine");
    expect(r.drift).toBe("bound");
    expect(r.last_run).toBeNull();
  });

  it("fail-open: returns empty list when routines directory is absent", async () => {
    const { loadAllRoutines } = await import("@shared/routine.ts");
    vi.mocked(loadAllRoutines).mockResolvedValueOnce([]); // empty — dir absent

    const env = {
      existsSync: () => false,
      homeDir: "/home/test",
    };

    const result = await listRoutines({}, "/nonexistent", "/plugin", env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routines).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("returns drift 'unbound' for an enabled routine with no SKILL.md", async () => {
    const { loadAllRoutines } = await import("@shared/routine.ts");
    vi.mocked(loadAllRoutines).mockResolvedValueOnce([
      makeRoutine({
        name: "desktop-task-b",
        needs: { daemon: true, state: "local-canon" },
        status: "enabled",
      }),
    ]);

    const env = {
      existsSync: () => false, // no SKILL.md
      homeDir: "/home/test",
    };

    const result = await listRoutines({}, "/project", "/plugin", env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routines[0].drift).toBe("unbound");
  });

  it("filter_status: returns only routines matching the filter", async () => {
    const { loadAllRoutines } = await import("@shared/routine.ts");
    vi.mocked(loadAllRoutines).mockResolvedValueOnce([
      makeRoutine({ name: "enabled-1", status: "enabled" }),
      makeRoutine({ name: "disabled-1", status: "disabled" }),
      makeRoutine({ name: "enabled-2", status: "enabled" }),
    ]);

    const env = { existsSync: () => false, homeDir: "/home/test" };
    const result = await listRoutines({ filter_status: "enabled" }, "/project", "/plugin", env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routines).toHaveLength(2);
    expect(result.routines.every((r) => r.status === "enabled")).toBe(true);
  });

  it("includes last_run from state when available", async () => {
    const { loadAllRoutines } = await import("@shared/routine.ts");
    vi.mocked(loadAllRoutines).mockResolvedValueOnce([makeRoutine({ name: "routine-with-state" })]);

    const { readRoutineState } = await import("../services/routine-state.ts");
    vi.mocked(readRoutineState).mockResolvedValueOnce({
      last_outcome: "success",
      last_run: "2026-06-08T10:00:00Z",
    });

    const env = { existsSync: () => false, homeDir: "/home/test" };
    const result = await listRoutines({}, "/project", "/plugin", env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routines[0].last_run).toBe("2026-06-08T10:00:00Z");
  });
});
