/**
 * build-spawn-requests — unit tests for ADR-014 tool scoping field forwarding.
 *
 * Tests that buildSpawnRequests correctly forwards tools, disallowed_tools, and
 * permission_mode from SpawnPromptEntry to SpawnRequest, and correctly omits them
 * when absent.
 */

import type { SpawnPromptEntry } from "@features/prompt-pipeline/model/types.ts";
import { describe, expect, test } from "vitest";
import { buildSpawnRequests } from "../drive-flow.ts";
import type { ConsultationPromptEntry } from "../enter-and-prepare-state.ts";

// Minimal valid SpawnPromptEntry (without tool scoping fields)
const baseEntry = (): SpawnPromptEntry => ({
  agent: "canon:canon-implementor",
  prompt: "Do the thing",
  template_paths: [],
});

describe("buildSpawnRequests — ADR-014 tool scoping fields", () => {
  test("forwards tools from SpawnPromptEntry to SpawnRequest", () => {
    const entry: SpawnPromptEntry = {
      ...baseEntry(),
      tools: ["Bash", "Read", "Write"],
    };
    const [req] = buildSpawnRequests([entry]);
    expect(req.tools).toEqual(["Bash", "Read", "Write"]);
  });

  test("forwards disallowed_tools from SpawnPromptEntry to SpawnRequest", () => {
    const entry: SpawnPromptEntry = {
      ...baseEntry(),
      disallowed_tools: ["Bash"],
    };
    const [req] = buildSpawnRequests([entry]);
    expect(req.disallowed_tools).toEqual(["Bash"]);
  });

  test("forwards permission_mode from SpawnPromptEntry to SpawnRequest", () => {
    const entry: SpawnPromptEntry = {
      ...baseEntry(),
      permission_mode: "deny_unknown",
    };
    const [req] = buildSpawnRequests([entry]);
    expect(req.permission_mode).toBe("deny_unknown");
  });

  test("omits tools key entirely when not present in entry", () => {
    const entry: SpawnPromptEntry = baseEntry();
    const [req] = buildSpawnRequests([entry]);
    expect(Object.hasOwn(req, "tools")).toBe(false);
  });

  test("omits disallowed_tools key entirely when not present in entry", () => {
    const entry: SpawnPromptEntry = baseEntry();
    const [req] = buildSpawnRequests([entry]);
    expect(Object.hasOwn(req, "disallowed_tools")).toBe(false);
  });

  test("omits permission_mode key entirely when not present in entry", () => {
    const entry: SpawnPromptEntry = baseEntry();
    const [req] = buildSpawnRequests([entry]);
    expect(Object.hasOwn(req, "permission_mode")).toBe(false);
  });

  test("forwards all three fields together when all are present", () => {
    const entry: SpawnPromptEntry = {
      ...baseEntry(),
      disallowed_tools: ["Bash"],
      permission_mode: "auto",
      tools: ["Read", "Write"],
    };
    const [req] = buildSpawnRequests([entry]);
    expect(req.tools).toEqual(["Read", "Write"]);
    expect(req.disallowed_tools).toEqual(["Bash"]);
    expect(req.permission_mode).toBe("auto");
  });

  test("backward compat: entries without new fields produce requests without them", () => {
    const entry: SpawnPromptEntry = {
      agent: "canon:canon-researcher",
      prompt: "Research the codebase",
      role: "researcher",
      template_paths: [],
    };
    const [req] = buildSpawnRequests([entry]);
    expect(req.agent_type).toBe("canon:canon-researcher");
    expect(req.role).toBe("researcher");
    expect(Object.hasOwn(req, "tools")).toBe(false);
    expect(Object.hasOwn(req, "disallowed_tools")).toBe(false);
    expect(Object.hasOwn(req, "permission_mode")).toBe(false);
  });

  test("consultation spawns get tool scope from their agent profile", () => {
    const consultation: ConsultationPromptEntry = {
      agent: "canon:canon-researcher",
      name: "research-consult",
      prompt: "Consult on the research",
      role: "consultation",
    };
    const reqs = buildSpawnRequests([baseEntry()], [consultation]);
    const consultReq = reqs.find((r) => r.role === "consultation");
    expect(consultReq).toBeDefined();
    expect(consultReq!.tools).toBeDefined();
    expect(consultReq!.tools!.length).toBeGreaterThan(0);
    expect(consultReq!.permission_mode).toBe("prompt");
    // researcher has Edit/Write/NotebookEdit disallowed
    expect(consultReq!.disallowed_tools).toContain("Edit");
  });
});
