/**
 * build-spawn-requests — unit tests for ADR-014 tool scoping field forwarding.
 *
 * Tests that buildSpawnRequests correctly forwards tools, disallowed_tools, and
 * permission_mode from SpawnPromptEntry to SpawnRequest, and correctly omits them
 * when absent.
 */

import { describe, expect, test } from "vitest";
import { buildSpawnRequests } from "../drive-flow.ts";
import type { SpawnPromptEntry } from "@features/prompt-pipeline/model/types.ts";

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
    expect(Object.prototype.hasOwnProperty.call(req, "tools")).toBe(false);
  });

  test("omits disallowed_tools key entirely when not present in entry", () => {
    const entry: SpawnPromptEntry = baseEntry();
    const [req] = buildSpawnRequests([entry]);
    expect(Object.prototype.hasOwnProperty.call(req, "disallowed_tools")).toBe(false);
  });

  test("omits permission_mode key entirely when not present in entry", () => {
    const entry: SpawnPromptEntry = baseEntry();
    const [req] = buildSpawnRequests([entry]);
    expect(Object.prototype.hasOwnProperty.call(req, "permission_mode")).toBe(false);
  });

  test("forwards all three fields together when all are present", () => {
    const entry: SpawnPromptEntry = {
      ...baseEntry(),
      tools: ["Read", "Write"],
      disallowed_tools: ["Bash"],
      permission_mode: "auto",
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
      template_paths: [],
      role: "researcher",
    };
    const [req] = buildSpawnRequests([entry]);
    expect(req.agent_type).toBe("canon:canon-researcher");
    expect(req.role).toBe("researcher");
    expect(Object.prototype.hasOwnProperty.call(req, "tools")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(req, "disallowed_tools")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(req, "permission_mode")).toBe(false);
  });
});
