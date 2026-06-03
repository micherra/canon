/**
 * invoke-janitor unit tests (1c)
 *
 * Guards the explicit-scope contract:
 *   invokeJanitor(input, scope) targets input.project_dir || scope.
 *   No call to process.cwd() or process.env.CANON_PROJECT_DIR.
 */

import type { JanitorResult } from "@features/orchestration/services/janitor.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock runJanitor so no real filesystem work happens.
vi.mock("@features/orchestration/services/janitor.ts", () => ({
  runJanitor: vi.fn(),
}));

import { runJanitor } from "@features/orchestration/services/janitor.ts";
import { invokeJanitor } from "../tools/invoke-janitor.ts";

const mockRunJanitor = vi.mocked(runJanitor);

const FAKE_JANITOR_RESULT: JanitorResult = {
  gate_passed: false,
  needs_prune: false,
  reason: "janitor disabled",
  tasks: {},
};

describe("invokeJanitor — explicit scope", () => {
  beforeEach(() => {
    mockRunJanitor.mockResolvedValue(FAKE_JANITOR_RESULT);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the passed scope when input.project_dir is absent", async () => {
    const scope = "/explicit/project/dir";
    await invokeJanitor({}, scope);
    expect(mockRunJanitor).toHaveBeenCalledWith(scope);
  });

  it("uses input.project_dir when provided (explicit caller override wins)", async () => {
    const scope = "/scope/dir";
    const explicit = "/caller/specified/dir";
    await invokeJanitor({ project_dir: explicit }, scope);
    expect(mockRunJanitor).toHaveBeenCalledWith(explicit);
  });

  it("never reads process.cwd() — cwd is a different path but scope is used", async () => {
    // We can't easily chdir in vitest, but we can confirm the scope arg is what runs.
    const scope = "/canonical/project";
    await invokeJanitor({}, scope);
    // If it used process.cwd() the path would differ; only the scope is valid here.
    expect(mockRunJanitor).toHaveBeenCalledOnce();
    expect(mockRunJanitor).toHaveBeenCalledWith(scope);
  });

  it("never reads CANON_PROJECT_DIR env — env is different but scope wins", async () => {
    const originalEnv = process.env.CANON_PROJECT_DIR;
    process.env.CANON_PROJECT_DIR = "/env/project/dir";
    try {
      const scope = "/scope/not/env";
      await invokeJanitor({}, scope);
      expect(mockRunJanitor).toHaveBeenCalledWith(scope);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CANON_PROJECT_DIR;
      } else {
        process.env.CANON_PROJECT_DIR = originalEnv;
      }
    }
  });

  it("returns ok:true wrapping the janitor result", async () => {
    const result = await invokeJanitor({}, "/some/dir");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.janitor).toEqual(FAKE_JANITOR_RESULT);
    }
  });
});
