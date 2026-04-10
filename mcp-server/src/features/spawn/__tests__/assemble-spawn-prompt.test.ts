import { describe, expect, it } from "vitest";
import {
  assembleSpawnPrompt,
  CANON_ROLES,
  type CanonRole,
  getRoleArtifactContract,
  type UpstreamArtifactRef,
} from "../index.ts";

const WORKSPACE_ID = "ws-phase-1-smoke";

/**
 * Minimal fixture: a single upstream synthesis artifact produced by the
 * researcher. Re-used across most role tests so fixtures stay compact.
 */
const researchSynthesisRef: UpstreamArtifactRef = {
  id: "research_synthesis",
  path: "research/SYNTHESIS.md",
  produced_by: "canon-researcher",
  description: "Compressed findings from the research step",
};

const planIndexRef: UpstreamArtifactRef = {
  id: "plan_index",
  path: "plans/INDEX.md",
  produced_by: "canon-architect",
  description: "Architect-authored plan index",
};

const implementationSummaryRef: UpstreamArtifactRef = {
  id: "implementation_summary",
  path: "plans/SUMMARY.md",
  produced_by: "canon-implementor",
  description: "Implementor summary of the commit",
};

describe("assembleSpawnPrompt", () => {
  it("emits role header, workspace id, and task type in every prompt", () => {
    const prompt = assembleSpawnPrompt({
      role: "canon-researcher",
      task_type: "research",
      target_files: ["src/foo.ts"],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
    });

    expect(prompt).toContain("# Canon teammate: canon-researcher");
    expect(prompt).toContain("Task type: `research`");
    expect(prompt).toContain(`Workspace: \`${WORKSPACE_ID}\``);
  });

  it("renders target files as a bullet list", () => {
    const prompt = assembleSpawnPrompt({
      role: "canon-researcher",
      task_type: "research",
      target_files: ["src/a.ts", "src/b.ts", "docs/c.md"],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
    });

    expect(prompt).toContain("- `src/a.ts`");
    expect(prompt).toContain("- `src/b.ts`");
    expect(prompt).toContain("- `docs/c.md`");
  });

  it("explains entry-point steps when upstream_artifact_refs is empty", () => {
    const prompt = assembleSpawnPrompt({
      role: "canon-researcher",
      task_type: "research",
      target_files: ["src/x.ts"],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
    });

    expect(prompt).toContain("entry-point step");
  });

  it("lists every upstream artifact with id, path, and producer", () => {
    const prompt = assembleSpawnPrompt({
      role: "canon-reviewer",
      task_type: "review",
      target_files: ["src/x.ts"],
      upstream_artifact_refs: [
        researchSynthesisRef,
        planIndexRef,
        implementationSummaryRef,
      ],
      workspace_id: WORKSPACE_ID,
    });

    expect(prompt).toContain("`research/SYNTHESIS.md`");
    expect(prompt).toContain("id: `research_synthesis`");
    expect(prompt).toContain("produced by `canon-researcher`");

    expect(prompt).toContain("`plans/INDEX.md`");
    expect(prompt).toContain("id: `plan_index`");
    expect(prompt).toContain("produced by `canon-architect`");

    expect(prompt).toContain("`plans/SUMMARY.md`");
    expect(prompt).toContain("id: `implementation_summary`");
    expect(prompt).toContain("produced by `canon-implementor`");
  });

  it("includes a completion contract with the workspace-scoped artifact path", () => {
    const prompt = assembleSpawnPrompt({
      role: "canon-researcher",
      task_type: "research",
      target_files: ["src/x.ts"],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
    });

    expect(prompt).toContain("## Task-completion contract");
    expect(prompt).toContain(
      `.canon/workspaces/${WORKSPACE_ID}/research/SYNTHESIS.md`,
    );
    expect(prompt).toContain("`research_synthesis`");
    expect(prompt).toContain("TaskCompleted");
  });

  it("includes a Canon principles section in every prompt", () => {
    const prompt = assembleSpawnPrompt({
      role: "canon-implementor",
      task_type: "implement",
      target_files: ["src/impl.ts"],
      upstream_artifact_refs: [researchSynthesisRef, planIndexRef],
      workspace_id: WORKSPACE_ID,
    });

    expect(prompt).toContain("## Canon principles");
  });

  it("provides task-type guidance that matches the role", () => {
    const implementerPrompt = assembleSpawnPrompt({
      role: "canon-implementor",
      task_type: "implement",
      target_files: ["src/x.ts"],
      upstream_artifact_refs: [researchSynthesisRef, planIndexRef],
      workspace_id: WORKSPACE_ID,
    });
    expect(implementerPrompt.toLowerCase()).toContain("write code");

    const researcherPrompt = assembleSpawnPrompt({
      role: "canon-researcher",
      task_type: "research",
      target_files: ["src/x.ts"],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
    });
    expect(researcherPrompt).toContain("Do NOT write code");

    const reviewerPrompt = assembleSpawnPrompt({
      role: "canon-reviewer",
      task_type: "review",
      target_files: ["src/x.ts"],
      upstream_artifact_refs: [implementationSummaryRef],
      workspace_id: WORKSPACE_ID,
    });
    expect(reviewerPrompt).toContain("verdict");
  });

  it("throws on unknown role", () => {
    expect(() =>
      assembleSpawnPrompt({
        // biome-ignore lint/suspicious/noExplicitAny: intentional invalid role
        role: "canon-unknown" as any,
        task_type: "research",
        target_files: [],
        upstream_artifact_refs: [],
        workspace_id: WORKSPACE_ID,
      }),
    ).toThrow(/unknown role/);
  });

  it("is deterministic across repeated calls with identical input", () => {
    const input = {
      role: "canon-architect" as CanonRole,
      task_type: "design" as const,
      target_files: ["src/a.ts", "src/b.ts"],
      upstream_artifact_refs: [researchSynthesisRef],
      workspace_id: WORKSPACE_ID,
    };
    const a = assembleSpawnPrompt(input);
    const b = assembleSpawnPrompt(input);
    expect(a).toBe(b);
  });
});

describe("assembleSpawnPrompt — coverage for all Canon roles", () => {
  // Smoke test: every role in CANON_ROLES must produce a prompt with its
  // declared artifact path. This guarantees the ROLE_ARTIFACT_CONTRACTS
  // table stays in sync with the exported role list.
  it.each(CANON_ROLES)("produces a contract-bearing prompt for %s", (role) => {
    const contract = getRoleArtifactContract(role);
    const prompt = assembleSpawnPrompt({
      role,
      task_type: "research",
      target_files: [],
      upstream_artifact_refs: [],
      workspace_id: WORKSPACE_ID,
    });

    expect(prompt).toContain(`# Canon teammate: ${role}`);
    expect(prompt).toContain(contract.artifact_path);
    expect(prompt).toContain(`\`${contract.artifact_id}\``);
  });
});

describe("getRoleArtifactContract", () => {
  it("returns a stable contract per role", () => {
    const contract = getRoleArtifactContract("canon-reviewer");
    expect(contract.artifact_id).toBe("review");
    expect(contract.artifact_path).toBe("reviews/REVIEW.md");
  });

  it("returns a defensive copy", () => {
    const a = getRoleArtifactContract("canon-researcher");
    const b = getRoleArtifactContract("canon-researcher");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("throws on unknown role", () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional invalid role
    expect(() => getRoleArtifactContract("canon-foo" as any)).toThrow(
      /unknown role/,
    );
  });
});

describe("CANON_ROLES", () => {
  it("lists all 13 Canon roles", () => {
    expect(CANON_ROLES).toHaveLength(13);
    expect(CANON_ROLES).toContain("canon-researcher");
    expect(CANON_ROLES).toContain("canon-architect");
    expect(CANON_ROLES).toContain("canon-implementor");
    expect(CANON_ROLES).toContain("canon-reviewer");
  });
});
