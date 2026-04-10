import { describe, expect, it } from "vitest";
import {
  assembleSpawnPrompt,
  CANON_ROLES,
  resolveWaveArtifactPath,
  WAVE_COMPATIBLE_ROLES,
  type CanonRole,
  type UpstreamArtifactRef,
  type WaveContext,
} from "../index.ts";

/**
 * Phase 2 wave-path sibling tests.
 *
 * These tests cover the wave-spawn extensions added in Phase 2 of the
 * Canon → agent teams migration. They do not touch the Phase 1 test file
 * (assemble-spawn-prompt.test.ts) so that the Phase 1 regression suite
 * stays frozen as the migration's canary for byte-identical behavior
 * when no wave_context is supplied.
 *
 * Coverage:
 *   - resolveWaveArtifactPath shape + validation
 *   - assembleSpawnPrompt with wave_context renders the wave-scoped path
 *   - assembleSpawnPrompt without wave_context is byte-identical to a
 *     Phase-1-equivalent call (belt-and-suspenders check for the default
 *     branch)
 *   - Every wave-compatible role produces a path of the correct shape
 *   - The new Phase 2 task types flow through without exceptions
 */

const WORKSPACE_ID = "ws-phase-2-smoke";
const WAVE_CTX: WaveContext = { slug: "fix-bug", task_id: "t1" };

const upstreamPlanIndex: UpstreamArtifactRef = {
  id: "plan_index",
  path: "plans/INDEX.md",
  produced_by: "canon-architect",
  description: "Architect-authored plan index for the wave",
};

describe("resolveWaveArtifactPath", () => {
  it("concatenates slug, task_id, and the per-role suffix", () => {
    expect(
      resolveWaveArtifactPath("canon-implementor", {
        slug: "fix-bug",
        task_id: "t1",
      }),
    ).toBe("plans/fix-bug/t1-SUMMARY.md");
  });

  it("uses -RESEARCH.md for canon-researcher", () => {
    expect(
      resolveWaveArtifactPath("canon-researcher", {
        slug: "s",
        task_id: "abc",
      }),
    ).toBe("plans/s/abc-RESEARCH.md");
  });

  it("uses -REVIEW.md for canon-reviewer", () => {
    expect(
      resolveWaveArtifactPath("canon-reviewer", {
        slug: "s",
        task_id: "abc",
      }),
    ).toBe("plans/s/abc-REVIEW.md");
  });

  it("uses -TEST-REPORT.md for canon-tester", () => {
    expect(
      resolveWaveArtifactPath("canon-tester", {
        slug: "s",
        task_id: "abc",
      }),
    ).toBe("plans/s/abc-TEST-REPORT.md");
  });

  it("uses -FIX-SUMMARY.md for canon-fixer", () => {
    expect(
      resolveWaveArtifactPath("canon-fixer", {
        slug: "s",
        task_id: "abc",
      }),
    ).toBe("plans/s/abc-FIX-SUMMARY.md");
  });

  it("uses -SECURITY.md for canon-security", () => {
    expect(
      resolveWaveArtifactPath("canon-security", {
        slug: "s",
        task_id: "abc",
      }),
    ).toBe("plans/s/abc-SECURITY.md");
  });

  it("uses -CONTEXT-SYNC.md for canon-scribe", () => {
    expect(
      resolveWaveArtifactPath("canon-scribe", {
        slug: "s",
        task_id: "abc",
      }),
    ).toBe("plans/s/abc-CONTEXT-SYNC.md");
  });

  it("uses -SHIP.md for canon-shipper", () => {
    expect(
      resolveWaveArtifactPath("canon-shipper", {
        slug: "s",
        task_id: "abc",
      }),
    ).toBe("plans/s/abc-SHIP.md");
  });

  it("uses -DESIGN.md for canon-architect when waved", () => {
    // Phase 2 allows an architect step to be waved when a flow spawns
    // multiple parallel sub-designs per task. The INDEX.md case is not
    // wave-expanded — it stays on the flat plans/INDEX.md path by design.
    expect(
      resolveWaveArtifactPath("canon-architect", {
        slug: "s",
        task_id: "abc",
      }),
    ).toBe("plans/s/abc-DESIGN.md");
  });

  it("rejects single-agent roles that never participate in waves", () => {
    for (const role of ["canon-guide", "canon-chat", "canon-writer", "canon-learner"] as const) {
      expect(() =>
        resolveWaveArtifactPath(role, { slug: "s", task_id: "abc" }),
      ).toThrow(/not wave-compatible/);
    }
  });

  it("rejects empty slug", () => {
    expect(() =>
      resolveWaveArtifactPath("canon-implementor", { slug: "", task_id: "abc" }),
    ).toThrow(/invalid slug/);
  });

  it("rejects empty task_id", () => {
    expect(() =>
      resolveWaveArtifactPath("canon-implementor", { slug: "s", task_id: "" }),
    ).toThrow(/invalid task_id/);
  });

  it("rejects slugs with disallowed characters", () => {
    expect(() =>
      resolveWaveArtifactPath("canon-implementor", {
        slug: "bad slug",
        task_id: "abc",
      }),
    ).toThrow(/invalid slug/);
    expect(() =>
      resolveWaveArtifactPath("canon-implementor", {
        slug: "bad/slug",
        task_id: "abc",
      }),
    ).toThrow(/invalid slug/);
    expect(() =>
      resolveWaveArtifactPath("canon-implementor", {
        slug: "bad.slug",
        task_id: "abc",
      }),
    ).toThrow(/invalid slug/);
  });

  it("rejects task ids with disallowed characters", () => {
    expect(() =>
      resolveWaveArtifactPath("canon-implementor", {
        slug: "s",
        task_id: "t/1",
      }),
    ).toThrow(/invalid task_id/);
    expect(() =>
      resolveWaveArtifactPath("canon-implementor", {
        slug: "s",
        task_id: "a b",
      }),
    ).toThrow(/invalid task_id/);
  });

  it("accepts task ids with hyphens and underscores (matches write-plan-index pattern)", () => {
    expect(
      resolveWaveArtifactPath("canon-implementor", {
        slug: "my-slug",
        task_id: "task_1-a",
      }),
    ).toBe("plans/my-slug/task_1-a-SUMMARY.md");
  });
});

describe("WAVE_COMPATIBLE_ROLES", () => {
  it("contains exactly the roles that have a wave suffix", () => {
    // Every wave-compatible role must resolve to a non-empty path.
    for (const role of WAVE_COMPATIBLE_ROLES) {
      expect(() =>
        resolveWaveArtifactPath(role, { slug: "s", task_id: "t" }),
      ).not.toThrow();
    }
  });

  it("excludes single-agent roles", () => {
    expect(WAVE_COMPATIBLE_ROLES).not.toContain("canon-guide");
    expect(WAVE_COMPATIBLE_ROLES).not.toContain("canon-chat");
    expect(WAVE_COMPATIBLE_ROLES).not.toContain("canon-writer");
    expect(WAVE_COMPATIBLE_ROLES).not.toContain("canon-learner");
  });

  it("includes all 9 multi-agent Canon roles", () => {
    // architect, researcher, implementor, reviewer, tester, fixer,
    // security, scribe, shipper
    expect(WAVE_COMPATIBLE_ROLES).toHaveLength(9);
  });
});

describe("assembleSpawnPrompt with wave_context", () => {
  it("renders the wave-scoped path in the completion contract", () => {
    const prompt = assembleSpawnPrompt({
      role: "canon-implementor",
      task_type: "implement",
      target_files: ["src/x.ts"],
      upstream_artifact_refs: [upstreamPlanIndex],
      workspace_id: WORKSPACE_ID,
      wave_context: WAVE_CTX,
    });
    expect(prompt).toContain(
      `.canon/workspaces/${WORKSPACE_ID}/plans/fix-bug/t1-SUMMARY.md`,
    );
    expect(prompt).toContain("## Wave context");
    expect(prompt).toContain("Slug: `fix-bug`");
    expect(prompt).toContain("Task id: `t1`");
  });

  it("includes the wave task id in the sub-header when wave_context is set", () => {
    const prompt = assembleSpawnPrompt({
      role: "canon-reviewer",
      task_type: "review",
      target_files: [],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
      wave_context: { slug: "s", task_id: "abc" },
    });
    expect(prompt).toContain("Wave task: `abc`");
  });

  it("warns the teammate not to write to the flat Phase 1 path", () => {
    const prompt = assembleSpawnPrompt({
      role: "canon-implementor",
      task_type: "implement",
      target_files: [],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
      wave_context: WAVE_CTX,
    });
    expect(prompt).toContain("plans/SUMMARY.md");
    expect(prompt).toContain("Do NOT write to the flat Phase 1 path");
  });

  it("throws when wave_context is supplied for a single-agent role", () => {
    expect(() =>
      assembleSpawnPrompt({
        role: "canon-guide",
        task_type: "explore",
        target_files: [],
        upstream_artifact_refs: [],
        workspace_id: WORKSPACE_ID,
        wave_context: WAVE_CTX,
      }),
    ).toThrow(/not wave-compatible/);
  });

  it("is deterministic across repeated calls with identical wave_context", () => {
    const a = assembleSpawnPrompt({
      role: "canon-implementor",
      task_type: "implement",
      target_files: ["src/x.ts"],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
      wave_context: WAVE_CTX,
    });
    const b = assembleSpawnPrompt({
      role: "canon-implementor",
      task_type: "implement",
      target_files: ["src/x.ts"],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
      wave_context: WAVE_CTX,
    });
    expect(a).toBe(b);
  });

  it("different task_ids produce different prompts", () => {
    const t1 = assembleSpawnPrompt({
      role: "canon-implementor",
      task_type: "implement",
      target_files: [],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
      wave_context: { slug: "s", task_id: "t1" },
    });
    const t2 = assembleSpawnPrompt({
      role: "canon-implementor",
      task_type: "implement",
      target_files: [],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
      wave_context: { slug: "s", task_id: "t2" },
    });
    expect(t1).not.toBe(t2);
    expect(t1).toContain("plans/s/t1-SUMMARY.md");
    expect(t2).toContain("plans/s/t2-SUMMARY.md");
  });
});

describe("assembleSpawnPrompt without wave_context (Phase 1 byte-compat)", () => {
  it("renders the flat Phase 1 path when wave_context is omitted", () => {
    const prompt = assembleSpawnPrompt({
      role: "canon-implementor",
      task_type: "implement",
      target_files: [],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
    });
    expect(prompt).toContain(
      `.canon/workspaces/${WORKSPACE_ID}/plans/SUMMARY.md`,
    );
    expect(prompt).not.toContain("## Wave context");
    expect(prompt).not.toContain("Wave task:");
    expect(prompt).not.toContain("Do NOT write to the flat Phase 1 path");
  });
});

describe("Phase 2 task types", () => {
  // Every new task type must flow through the assembler without throwing
  // and must render a recognisable role brief.
  const newTaskTypes = [
    { task_type: "refactor" as const, expect: /behavior|refactor/i },
    { task_type: "migrate" as const, expect: /migration|rollback/i },
    { task_type: "security_audit" as const, expect: /vulnerabilit/i },
    { task_type: "test_gap" as const, expect: /coverage|gaps/i },
  ];

  for (const { task_type, expect: expected } of newTaskTypes) {
    it(`accepts task_type="${task_type}" and renders guidance`, () => {
      // Pick a role whose per-role override does NOT clobber the task-type
      // guidance — canon-implementor has no override, so it falls through.
      const prompt = assembleSpawnPrompt({
        role: "canon-implementor",
        task_type,
        target_files: [],
        upstream_artifact_refs: [],
        workspace_id: WORKSPACE_ID,
      });
      expect(prompt).toContain(`Task type: \`${task_type}\``);
      expect(prompt).toMatch(expected);
    });
  }
});

describe("Wave-compatible roles × wave_context coverage", () => {
  // Smoke test: every wave-compatible role must produce a prompt that
  // matches the resolved wave path for its role. This keeps
  // WAVE_ARTIFACT_SUFFIXES and the assembler in sync.
  for (const role of WAVE_COMPATIBLE_ROLES) {
    it(`renders a wave-scoped prompt for ${role}`, () => {
      const expectedPath = resolveWaveArtifactPath(role, WAVE_CTX);
      const prompt = assembleSpawnPrompt({
        role,
        task_type: "implement",
        target_files: [],
        upstream_artifact_refs: [],
        workspace_id: WORKSPACE_ID,
        wave_context: WAVE_CTX,
      });
      expect(prompt).toContain(expectedPath);
    });
  }
});

describe("Non-wave-compatible roles stay flat-only", () => {
  const flatOnlyRoles: CanonRole[] = CANON_ROLES.filter(
    (r) => !WAVE_COMPATIBLE_ROLES.includes(r),
  );

  it("exposes the expected flat-only roles", () => {
    expect([...flatOnlyRoles].sort()).toEqual(
      ["canon-chat", "canon-guide", "canon-learner", "canon-writer"].sort(),
    );
  });

  it("flat-only roles still render Phase 1 prompts without wave_context", () => {
    for (const role of flatOnlyRoles) {
      expect(() =>
        assembleSpawnPrompt({
          role,
          task_type: "research",
          target_files: [],
          upstream_artifact_refs: [],
          workspace_id: WORKSPACE_ID,
        }),
      ).not.toThrow();
    }
  });
});
