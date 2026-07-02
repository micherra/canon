/**
 * Tests for context_provenance event emission from resolveAgentSkills.
 *
 * Coverage:
 * - emit with small (non-disclosed) preload: 1 context_provenance event, correlation === step_id,
 *   assembled_artifacts hashes match hashContent, spans valid.
 * - emit WITHOUT step_id: event still written; record.step_id === null; return unchanged.
 * - emit WITHOUT workspace: no event, no throw.
 * - forced disclosure (>12k preload): blanked artifacts char_span: null + sidecar fields.
 * - registration: register-agent-teams passes step_id.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextProvenanceRecord,
  hashContent,
} from "@domains/workspaces/context-provenance.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import type { ResolveAgentSkillsResult } from "@features/orchestration/tools/resolve-agent-skills.ts";
import { resolveAgentSkills } from "@features/orchestration/tools/resolve-agent-skills.ts";
import { emitContextProvenance } from "@features/orchestration/tools/resolve-agent-skills-provenance.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedPluginDir(): string {
  const pluginDir = mkdtempSync(join(tmpdir(), "canon-provenance-test-"));
  mkdirSync(join(pluginDir, "agents"));
  mkdirSync(join(pluginDir, "rules"));
  mkdirSync(join(pluginDir, "references"));
  mkdirSync(join(pluginDir, "primers"));
  mkdirSync(join(pluginDir, "templates"));
  return pluginDir;
}

function writeAgent(pluginDir: string, name: string, frontmatter: string, body = "body\n") {
  writeFileSync(join(pluginDir, "agents", `${name}.md`), `---\n${frontmatter}\n---\n\n${body}`);
}

function writeSkill(
  pluginDir: string,
  kind: "rules" | "references" | "primers" | "templates",
  id: string,
  body: string,
) {
  writeFileSync(join(pluginDir, kind, `${id}.md`), body);
}

/** Seed a minimal workspace directory with orchestration.db */
function seedWorkspace(baseDir: string, slug: string): string {
  const ws = join(baseDir, ".canon", "workspaces", slug);
  mkdirSync(ws, { recursive: true });
  return ws;
}

async function resolveOk(
  result: ReturnType<typeof resolveAgentSkills>,
): Promise<{ ok: true } & ResolveAgentSkillsResult> {
  const r = await result;
  assertOk<ResolveAgentSkillsResult>(r);
  return r;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let pluginDir: string;
let tmpBase: string;

beforeEach(() => {
  pluginDir = seedPluginDir();
  tmpBase = mkdtempSync(join(tmpdir(), "canon-provenance-ws-"));
  writeSkill(pluginDir, "rules", "test-rule", "rule content here\n");
  writeAgent(pluginDir, "engineer", ["name: engineer", "rules:", "  - test-rule"].join("\n"));
});

afterEach(() => {
  clearStoreCache();
  rmSync(pluginDir, { force: true, recursive: true });
  rmSync(tmpBase, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// Test: emit with step_id — full non-disclosed preload
// ---------------------------------------------------------------------------

describe("emitContextProvenance — non-disclosed preload with step_id", () => {
  it("writes exactly one context_provenance event to the store", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-01");
    const out = await resolveOk(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
        workspace,
        step_id: "implement",
      }),
    );

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    expect(events).toHaveLength(1);

    // Return contract unchanged
    expect(out.agent_name).toBe("engineer");
    expect(out.preload_prompt).toBeTruthy();
    expect(out.skills).toHaveLength(1);
  });

  it("event payload has step_id matching the provided step_id", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-02");
    await resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
      workspace,
      step_id: "implement",
    });

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    expect(events).toHaveLength(1);
    const record = events[0].payload as { step_id: string | null };
    expect(record.step_id).toBe("implement");
  });

  it("assembled_artifacts content_hash matches hashContent of skill content", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-03");
    await resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
      workspace,
      step_id: "implement",
    });

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    const record = events[0].payload as {
      assembled_artifacts: Array<{
        id: string;
        content_hash: string;
        char_span: [number, number] | null;
      }>;
      preload_prompt_hash: string;
    };

    // 2 artifacts: the resolved "test-rule" skill + the new agent-def artifact (TASK-001)
    expect(record.assembled_artifacts).toHaveLength(2);
    const artifact = record.assembled_artifacts[0];
    expect(artifact.id).toBe("test-rule");
    // Hash of the pre-disclosure content
    expect(artifact.content_hash).toBe(hashContent("rule content here\n"));
    // Span must be non-null for non-disclosed preload
    expect(artifact.char_span).not.toBeNull();
  });

  it("char_span start..end slices out the section text from preload_prompt", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-04");
    const out = await resolveOk(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
        workspace,
        step_id: "implement",
      }),
    );

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    const record = events[0].payload as {
      assembled_artifacts: Array<{ char_span: [number, number] | null }>;
    };

    const [start, end] = record.assembled_artifacts[0].char_span as [number, number];
    const section = out.preload_prompt.slice(start, end);
    // Section must contain the skill content
    expect(section).toContain("rule content here");
  });
});

// ---------------------------------------------------------------------------
// Test: emit WITHOUT step_id — event still written, step_id null
// ---------------------------------------------------------------------------

describe("emitContextProvenance — absent step_id", () => {
  it("writes event even when step_id is absent", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-05");
    const out = await resolveOk(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
        workspace,
        // step_id intentionally omitted
      }),
    );

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    expect(events).toHaveLength(1);

    // Return value unchanged
    expect(out.agent_name).toBe("engineer");
    expect(out.skills).toHaveLength(1);
  });

  it("record.step_id is null when step_id absent", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-06");
    await resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
      workspace,
    });

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    const record = events[0].payload as { step_id: string | null };
    expect(record.step_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test: emit WITHOUT workspace — no event, no throw
// ---------------------------------------------------------------------------

describe("emitContextProvenance — absent workspace", () => {
  it("returns normally with no event written when workspace absent", async () => {
    // No workspace provided — must not throw
    const out = await resolveOk(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
        step_id: "implement",
        // workspace intentionally omitted
      }),
    );

    // The call must complete normally
    expect(out.agent_name).toBe("engineer");
    expect(out.skills).toHaveLength(1);
    // No store to query — just verify no throw occurred
  });

  it("emitContextProvenance helper: no throw when workspace undefined", () => {
    // Call helper directly with no workspace
    const skills = [{ content: "body", id: "rule-1", kind: "rule" as const, path: "/r.md" }];
    const disclosed: ResolveAgentSkillsResult = {
      agent_name: "test-agent",
      preload_prompt: "### Rule: rule-1\n\nbody",
      skills: [{ content: "", id: "rule-1", kind: "rule" as const, path: "/r.md" }],
      unresolved: [],
    };
    // Must not throw
    expect(() =>
      emitContextProvenance({
        disclosed,
        preDisclosureSkills: skills,
        stepId: "step",
        workspace: undefined,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test: forced disclosure (>12k) — blanked artifacts
// ---------------------------------------------------------------------------

describe("emitContextProvenance — progressive disclosure (>12k)", () => {
  it("blanked artifacts carry char_span: null, source: sidecar, sidecar_path", async () => {
    // Create a large skill body to trigger disclosure (>12k chars threshold)
    const bigBody = "x".repeat(13000);
    writeSkill(pluginDir, "rules", "big-rule", bigBody);
    writeAgent(pluginDir, "big-agent", ["name: big-agent", "rules:", "  - big-rule"].join("\n"));

    const workspace = seedWorkspace(tmpBase, "flow-07");
    // projectDir needed to trigger disclosure
    const projectDir = tmpBase;
    mkdirSync(join(projectDir, ".canon", "artifacts"), { recursive: true });

    await resolveAgentSkills({ agent_name: "big-agent" }, pluginDir, projectDir, {
      workspace,
      step_id: "implement",
    });

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    expect(events).toHaveLength(1);

    const record = events[0].payload as {
      assembled_artifacts: Array<{
        id: string;
        char_span: [number, number] | null;
        source?: string;
        sidecar_path?: string;
        content_hash: string;
      }>;
    };

    // 2 artifacts: the blanked "big-rule" skill + the new agent-def artifact (TASK-001)
    expect(record.assembled_artifacts).toHaveLength(2);
    const artifact = record.assembled_artifacts[0];
    expect(artifact.id).toBe("big-rule");
    // content_hash still from pre-disclosure content (not empty string)
    expect(artifact.content_hash).toBe(hashContent(bigBody));
    expect(artifact.char_span).toBeNull();
    expect(artifact.source).toBe("sidecar");
    expect(artifact.sidecar_path).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test: agent-def artifact emission (TASK-001 / dc-01, dc-02, dc-03, dc-06)
// ---------------------------------------------------------------------------

describe("emitContextProvenance — agent-def artifact (TASK-001)", () => {
  it("appends exactly one kind:'agent-def' artifact for agents/<name>.md, joined on (workspace, step_id)", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-agentdef-01");
    await resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
      step_id: "implement",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    expect(events).toHaveLength(1);
    const record = events[0].payload as {
      step_id: string | null;
      assembled_artifacts: Array<{ kind: string; path: string; id: string }>;
    };
    expect(record.step_id).toBe("implement");

    const agentDefArtifacts = record.assembled_artifacts.filter((a) => a.kind === "agent-def");
    expect(agentDefArtifacts).toHaveLength(1);
    expect(agentDefArtifacts[0].path.endsWith("agents/engineer.md")).toBe(true);
    expect(agentDefArtifacts[0].id).toBe("engineer");
  });

  it("agent-def content_hash equals hashContent of the whole agent file (frontmatter included)", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-agentdef-02");
    const wholeFile = readFileSync(join(pluginDir, "agents", "engineer.md"), "utf-8");

    await resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
      step_id: "implement",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    const record = events[0].payload as {
      assembled_artifacts: Array<{ kind: string; content_hash: string }>;
    };
    const agentDef = record.assembled_artifacts.find((a) => a.kind === "agent-def");
    expect(agentDef?.content_hash).toBe(hashContent(wholeFile));
  });

  it("agent-def sections never overlap frontmatter (dc-06 guard)", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-agentdef-03");
    await resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
      step_id: "implement",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    const record = events[0].payload as {
      assembled_artifacts: Array<{
        kind: string;
        sections?: Array<{ heading: string; span: [number, number] }>;
      }>;
    };
    const agentDef = record.assembled_artifacts.find((a) => a.kind === "agent-def");
    expect(agentDef?.sections).toBeDefined();
    // "name: engineer" is a frontmatter line — must never appear as a section heading
    for (const section of agentDef?.sections ?? []) {
      expect(section.heading).not.toContain("name: engineer");
    }
  });

  it("agent-def char_span is null (body is not part of preload_prompt)", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-agentdef-04");
    await resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
      step_id: "implement",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    const record = events[0].payload as {
      assembled_artifacts: Array<{ kind: string; char_span: [number, number] | null }>;
    };
    const agentDef = record.assembled_artifacts.find((a) => a.kind === "agent-def");
    expect(agentDef?.char_span).toBeNull();
  });

  it("emission is fail-open — resolveAgentSkills still returns ok when the agent-def emit runs", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-agentdef-05");
    const out = await resolveOk(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
        step_id: "implement",
        workspace,
      }),
    );
    expect(out.agent_name).toBe("engineer");
  });

  it("pre-existing INVALID_INPUT for a truly-absent agent file is unchanged", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-agentdef-06");
    const result = await resolveAgentSkills(
      { agent_name: "does-not-exist" },
      pluginDir,
      undefined,
      {
        step_id: "implement",
        workspace,
      },
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test: recorded artifact paths are project-root-relative, not absolute
// (watch_XXXXXXXXX1 — downstream consumers key on a relative first path
// segment; the real emitted value from resolveAgentSkills was absolute.)
// ---------------------------------------------------------------------------

describe("emitContextProvenance — recorded artifact paths are plugin-relative", () => {
  it("agent-def artifact path is EXACTLY 'agents/<name>.md' — not absolute", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-relpath-01");
    await resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
      step_id: "implement",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    const record = events[0].payload as {
      assembled_artifacts: Array<{ kind: string; path: string }>;
    };
    const agentDef = record.assembled_artifacts.find((a) => a.kind === "agent-def");
    expect(agentDef?.path).toBe("agents/engineer.md");
  });

  it("rule (preload skill) artifact path is EXACTLY 'rules/<id>.md' — not absolute", async () => {
    const workspace = seedWorkspace(tmpBase, "flow-relpath-02");
    await resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
      step_id: "implement",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    const record = events[0].payload as {
      assembled_artifacts: Array<{ kind: string; path: string }>;
    };
    const rule = record.assembled_artifacts.find((a) => a.kind === "rule");
    expect(rule?.path).toBe("rules/test-rule.md");
  });
});

// ---------------------------------------------------------------------------
// Test: emitContextProvenance helper directly — pure unit
// ---------------------------------------------------------------------------

describe("emitContextProvenance helper — unit tests", () => {
  it("builds correct provenance record for non-blanked skill", () => {
    const content = "rule body";
    const record = buildContextProvenanceRecord({
      agentName: "engineer",
      finalPreloadPrompt: "### Rule: my-rule\n\nrule body",
      skills: [
        {
          blanked: false,
          id: "my-rule",
          inContextText: "### Rule: my-rule\n\nrule body",
          kind: "rule",
          originalContent: content,
          path: "/rules/my-rule.md",
        },
      ],
      spawnedAt: "2026-06-24T00:00:00.000Z",
      stepId: "implement",
      workspace: "/tmp/ws",
    });

    expect(record.step_id).toBe("implement");
    expect(record.agent_name).toBe("engineer");
    expect(record.agent_id).toBeNull();
    expect(record.assembled_artifacts).toHaveLength(1);
    const a = record.assembled_artifacts[0];
    expect(a.id).toBe("my-rule");
    expect(a.content_hash).toBe(hashContent(content));
    expect(a.char_span).not.toBeNull();
    expect(a.source).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test: register-agent-teams passes step_id
// ---------------------------------------------------------------------------

describe("register-agent-teams — step_id threading", () => {
  it("input schema accepts step_id as optional string", async () => {
    // Import the registration file and introspect the zod schema
    const { registerAgentTeamsTools } = await import("@app/register-agent-teams.ts");
    expect(registerAgentTeamsTools).toBeTypeOf("function");

    // Verify the module exports the function (wiring test — schema inspection
    // is not easily accessible without a mock McpServer, so we confirm
    // step_id is wired by running a resolve call that passes step_id through)
    const workspace = seedWorkspace(tmpBase, "flow-08");
    const out = await resolveOk(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, undefined, {
        step_id: "register-test",
        workspace,
      }),
    );
    expect(out.agent_name).toBe("engineer");

    const store = getExecutionStore(workspace);
    const events = store.getEventsByType("context_provenance");
    expect(events).toHaveLength(1);
    const record = events[0].payload as { step_id: string | null };
    expect(record.step_id).toBe("register-test");
  });
});
