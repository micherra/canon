import { afterEach, describe, expect, it, vi } from "vitest";

// Mock server-state first so no MCP server is instantiated during tests.
vi.mock("@app/server-state.ts", () => ({
  gatedWrapHandler: (handler: (input: unknown) => unknown) => handler,
  pluginDir: "/mock/plugin",
  projectDir: "/mock/project",
  server: { registerTool: vi.fn() },
}));

// Mock the tool implementations to avoid real I/O.
vi.mock("@features/orchestration/tools/drive-flow.ts", () => ({
  driveFlow: vi.fn(),
}));
vi.mock("@features/orchestration/tools/load-flow.ts", () => ({
  loadFlow: vi.fn(),
}));
vi.mock("@features/orchestration/tools/simulate-flow.ts", () => ({
  simulateFlowTool: vi.fn(),
}));

import { server } from "@app/server-state.ts";
import { registerDriveFlowTool } from "../register-drive-flow.ts";
import { registerFlowCoreTools } from "../register-flow-core.ts";

describe("registerDriveFlowTool — legacy flow gate", () => {
  const originalEnv = process.env.CANON_AGENT_TEAMS_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CANON_AGENT_TEAMS_MODE;
    } else {
      process.env.CANON_AGENT_TEAMS_MODE = originalEnv;
    }
    vi.mocked(server.registerTool).mockClear();
  });

  it("registers drive_flow tool when CANON_AGENT_TEAMS_MODE is unset", () => {
    delete process.env.CANON_AGENT_TEAMS_MODE;
    registerDriveFlowTool();
    expect(server.registerTool).toHaveBeenCalledOnce();
    expect(vi.mocked(server.registerTool).mock.calls[0][0]).toBe("drive_flow");
  });

  it("registers drive_flow tool when CANON_AGENT_TEAMS_MODE=off", () => {
    process.env.CANON_AGENT_TEAMS_MODE = "off";
    registerDriveFlowTool();
    expect(server.registerTool).toHaveBeenCalledOnce();
    expect(vi.mocked(server.registerTool).mock.calls[0][0]).toBe("drive_flow");
  });

  it("registers drive_flow but handler returns INVALID_INPUT when CANON_AGENT_TEAMS_MODE=on", async () => {
    process.env.CANON_AGENT_TEAMS_MODE = "on";
    registerDriveFlowTool();
    expect(server.registerTool).toHaveBeenCalledOnce();
    expect(vi.mocked(server.registerTool).mock.calls[0][0]).toBe("drive_flow");

    const handler = vi.mocked(server.registerTool).mock.calls[0][2] as (
      input: unknown,
    ) => Promise<unknown>;
    const result = await handler({});
    expect(result).toMatchObject({ error_code: "INVALID_INPUT", ok: false });
  });
});

describe("registerFlowCoreTools — legacy flow gate", () => {
  const originalEnv = process.env.CANON_AGENT_TEAMS_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CANON_AGENT_TEAMS_MODE;
    } else {
      process.env.CANON_AGENT_TEAMS_MODE = originalEnv;
    }
    vi.mocked(server.registerTool).mockClear();
  });

  it("registers load_flow and simulate_flow tools when CANON_AGENT_TEAMS_MODE is unset", () => {
    delete process.env.CANON_AGENT_TEAMS_MODE;
    registerFlowCoreTools();
    expect(server.registerTool).toHaveBeenCalledTimes(2);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("load_flow");
    expect(names).toContain("simulate_flow");
  });

  it("registers load_flow and simulate_flow tools when CANON_AGENT_TEAMS_MODE=off", () => {
    process.env.CANON_AGENT_TEAMS_MODE = "off";
    registerFlowCoreTools();
    expect(server.registerTool).toHaveBeenCalledTimes(2);
  });

  it("registers tools but handlers return INVALID_INPUT when CANON_AGENT_TEAMS_MODE=on", async () => {
    process.env.CANON_AGENT_TEAMS_MODE = "on";
    registerFlowCoreTools();
    expect(server.registerTool).toHaveBeenCalledTimes(2);

    const loadHandler = vi.mocked(server.registerTool).mock.calls[0][2] as (
      input: unknown,
    ) => Promise<unknown>;
    const simHandler = vi.mocked(server.registerTool).mock.calls[1][2] as (
      input: unknown,
    ) => Promise<unknown>;

    const loadResult = await loadHandler({ flow_name: "test" });
    expect(loadResult).toMatchObject({ error_code: "INVALID_INPUT", ok: false });

    const simResult = await simHandler({ flow: "test", scenario: [] });
    expect(simResult).toMatchObject({ error_code: "INVALID_INPUT", ok: false });
  });
});
