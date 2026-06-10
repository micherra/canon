import type { Routine } from "@shared/routine.ts";
import { describe, expect, it } from "vitest";
import { lintRoutines } from "../services/routine-lint.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  const base: Routine = {
    name: "release-ahead",
    title: "Release Ahead Check",
    status: "enabled",
    trigger: { kind: "schedule", cron: "0 9 * * 1" },
    needs: { state: "git-native", daemon: false },
    repos: ["owner/repo"],
    scope: "repo",
    guardrails: {
      mutates_running_build: false,
      repo_writes: "notify-only",
      consent: "opt-in",
    },
    recurrence: "standing",
    body: "Check release status ahead of main.",
    source: "plugin",
    filePath: "/fake/release-ahead.md",
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// lintRoutines
// ---------------------------------------------------------------------------

describe("lintRoutines", () => {
  it("valid fixture returns empty findings array", () => {
    const routines = [makeRoutine()];
    const findings = lintRoutines(routines);
    expect(findings).toEqual([]);
  });

  it("mutates_running_build:true → MUTATES_RUNNING_BUILD finding", () => {
    const routines = [
      makeRoutine({
        name: "bad-mutator",
        guardrails: {
          mutates_running_build: true,
          repo_writes: "notify-only",
          consent: "opt-in",
        },
      }),
    ];
    const findings = lintRoutines(routines);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("MUTATES_RUNNING_BUILD");
    expect(findings[0].routine).toBe("bad-mutator");
  });

  it("repo_writes:'merge' is not in allowed set → REPO_WRITES_CEILING finding", () => {
    // TypeScript's type system forbids "merge" for repo_writes, so cast via unknown
    const routines = [
      makeRoutine({
        name: "over-ceiling",
        guardrails: {
          mutates_running_build: false,
          repo_writes: "merge" as unknown as Routine["guardrails"]["repo_writes"],
          consent: "opt-in",
        },
      }),
    ];
    const findings = lintRoutines(routines);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("REPO_WRITES_CEILING");
    expect(findings[0].routine).toBe("over-ceiling");
  });

  it("standing draft-pr routine with consent:tier-gated → CONSENT_DEFAULT finding", () => {
    const routines = [
      makeRoutine({
        name: "durable-draft",
        recurrence: "standing",
        guardrails: {
          mutates_running_build: false,
          repo_writes: "draft-pr",
          consent: "tier-gated",
        },
      }),
    ];
    const findings = lintRoutines(routines);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CONSENT_DEFAULT");
    expect(findings[0].routine).toBe("durable-draft");
  });

  it("one-shot draft-pr with consent:tier-gated does NOT trigger CONSENT_DEFAULT", () => {
    const routines = [
      makeRoutine({
        name: "one-shot-draft",
        recurrence: "one-shot",
        guardrails: {
          mutates_running_build: false,
          repo_writes: "draft-pr",
          consent: "tier-gated",
        },
      }),
    ];
    const findings = lintRoutines(routines);
    const consentFindings = findings.filter((f) => f.code === "CONSENT_DEFAULT");
    expect(consentFindings).toHaveLength(0);
  });

  it("standing draft-pr with consent:opt-in does NOT trigger CONSENT_DEFAULT", () => {
    const routines = [
      makeRoutine({
        name: "standing-draft-optin",
        recurrence: "standing",
        guardrails: {
          mutates_running_build: false,
          repo_writes: "draft-pr",
          consent: "opt-in",
        },
      }),
    ];
    const findings = lintRoutines(routines);
    const consentFindings = findings.filter((f) => f.code === "CONSENT_DEFAULT");
    expect(consentFindings).toHaveLength(0);
  });

  it("binding_target:cloud-routine + needs.daemon:true → BINDING_OVERRIDE_CONTRADICTION (PRD AC#7 hard-fail)", () => {
    const routines = [
      makeRoutine({
        name: "bad-override-daemon",
        needs: { state: "git-native", daemon: true },
        binding_target: "cloud-routine",
      }),
    ];
    const findings = lintRoutines(routines);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("BINDING_OVERRIDE_CONTRADICTION");
    expect(findings[0].routine).toBe("bad-override-daemon");
  });

  it("binding_target:cloud-routine + state:local-canon → BINDING_OVERRIDE_CONTRADICTION", () => {
    const routines = [
      makeRoutine({
        name: "bad-override-state",
        needs: { state: "local-canon", daemon: false },
        binding_target: "cloud-routine",
      }),
    ];
    const findings = lintRoutines(routines);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("BINDING_OVERRIDE_CONTRADICTION");
    expect(findings[0].routine).toBe("bad-override-state");
  });

  it("binding_target:cloud-routine + git-native + daemon:false (agreeing) → no BINDING_OVERRIDE_CONTRADICTION", () => {
    const routines = [
      makeRoutine({
        name: "valid-override",
        needs: { state: "git-native", daemon: false },
        binding_target: "cloud-routine",
      }),
    ];
    const findings = lintRoutines(routines);
    const contradictions = findings.filter((f) => f.code === "BINDING_OVERRIDE_CONTRADICTION");
    expect(contradictions).toHaveLength(0);
  });

  it("binding_target:desktop-task + needs pointing to cloud → BINDING_OVERRIDE_CONTRADICTION", () => {
    const routines = [
      makeRoutine({
        name: "bad-override-desktop",
        needs: { state: "git-native", daemon: false },
        binding_target: "desktop-task",
      }),
    ];
    const findings = lintRoutines(routines);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("BINDING_OVERRIDE_CONTRADICTION");
  });

  it("returns findings from multiple routines", () => {
    const routines = [
      makeRoutine({ name: "routine-a" }),
      makeRoutine({
        name: "routine-b",
        guardrails: {
          mutates_running_build: true,
          repo_writes: "notify-only",
          consent: "opt-in",
        },
      }),
      makeRoutine({
        name: "routine-c",
        guardrails: {
          mutates_running_build: false,
          repo_writes: "merge" as unknown as Routine["guardrails"]["repo_writes"],
          consent: "opt-in",
        },
      }),
    ];
    const findings = lintRoutines(routines);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.routine)).toContain("routine-b");
    expect(findings.map((f) => f.routine)).toContain("routine-c");
  });

  it("empty routines array returns empty findings", () => {
    expect(lintRoutines([])).toEqual([]);
  });
});
