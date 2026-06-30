import { brandUntrusted } from "@shared/lib/overlay-untrusted-text.ts";
import type { Routine } from "@shared/routine.ts";
import { describe, expect, it } from "vitest";
import { resolveBinding, resolveRoutineBinding } from "../services/resolve-binding.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNeeds(state: Routine["needs"]["state"], daemon: boolean): Routine["needs"] {
  return { state, daemon };
}

function makeRoutine(needs: Routine["needs"], binding_target?: Routine["binding_target"]): Routine {
  return {
    name: "test-routine",
    title: brandUntrusted("Test Routine"),
    status: "enabled",
    trigger: { kind: "schedule", cron: "0 * * * *" },
    needs,
    binding_target,
    repos: ["owner/repo"],
    scope: "repo",
    guardrails: {
      mutates_running_build: false,
      repo_writes: "none",
      consent: "opt-in",
    },
    recurrence: "standing",
    body: brandUntrusted(""),
    source: "project",
    filePath: "/fake/routine.md",
  };
}

// ---------------------------------------------------------------------------
// resolveBinding — full matrix (4 cases)
// ---------------------------------------------------------------------------

describe("resolveBinding", () => {
  it("git-native + daemon:false → cloud-routine", () => {
    expect(resolveBinding(makeNeeds("git-native", false))).toBe("cloud-routine");
  });

  it("git-native + daemon:true → desktop-task", () => {
    expect(resolveBinding(makeNeeds("git-native", true))).toBe("desktop-task");
  });

  it("local-canon + daemon:false → desktop-task", () => {
    expect(resolveBinding(makeNeeds("local-canon", false))).toBe("desktop-task");
  });

  it("local-canon + daemon:true → desktop-task", () => {
    expect(resolveBinding(makeNeeds("local-canon", true))).toBe("desktop-task");
  });
});

// ---------------------------------------------------------------------------
// resolveRoutineBinding
// ---------------------------------------------------------------------------

describe("resolveRoutineBinding", () => {
  it("returns resolved target and overridden:false when no binding_target set", () => {
    const routine = makeRoutine(makeNeeds("git-native", false));
    const result = resolveRoutineBinding(routine);
    expect(result).toEqual({ target: "cloud-routine", overridden: false });
  });

  it("returns overridden:true when binding_target is set and agrees with resolver", () => {
    const routine = makeRoutine(makeNeeds("git-native", false), "cloud-routine");
    const result = resolveRoutineBinding(routine);
    expect(result).toEqual({ target: "cloud-routine", overridden: true });
  });

  it("returns overridden:false for desktop-task with no binding_target", () => {
    const routine = makeRoutine(makeNeeds("git-native", true));
    const result = resolveRoutineBinding(routine);
    expect(result).toEqual({ target: "desktop-task", overridden: false });
  });
});
