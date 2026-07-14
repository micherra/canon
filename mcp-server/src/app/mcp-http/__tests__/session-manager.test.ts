/**
 * session-manager.test.ts — unit tests for HTTP session manager.
 *
 * Covers:
 * - Session creation and registry (sessionCount)
 * - Teardown order spy (isolation-finish-01 pinned order)
 * - Refcount guard: same-dir two sessions, evictions fire only after last session closes
 * - Distinct dirs: evictions scoped to the closed session's dir only
 * - Idempotent teardown (second call is no-op)
 * - No-scope session: clearConnectionScope called but evictions skipped
 * - closeAllSessions drains registry
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks (must precede module imports) ──────────────────────────────

// Mock createCanonServer — returns a minimal McpServer-like object
vi.mock("../../create-server.ts", () => ({
  createCanonServer: vi.fn(),
}));

// Mock server-state — we spy on these to assert teardown order
vi.mock("../../server-state.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server-state.ts")>();
  return {
    ...original,
    clearConnectionScope: vi.fn(),
    clearSessionReady: vi.fn(),
    createSessionReadyGate: vi.fn(),
    getScopeForSession: vi.fn(),
    hasOtherSessionsForDir: vi.fn(),
    registerConnectionScope: vi.fn(),
    resolveSessionReady: vi.fn(),
    // Ensure all mocked functions are available
  };
});

// Mock eviction functions
vi.mock("../../../domains/workspaces/execution-store-cache.ts", () => ({
  evictStoresForScope: vi.fn(),
}));

vi.mock("../../../platform/jobs/job-manager.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../platform/jobs/job-manager.ts")>();
  return {
    ...original,
    evictJobManagerForScope: vi.fn(),
    getJobManager: vi.fn(),
  };
});

vi.mock("../../../platform/storage/drift/drift-db-cache.ts", () => ({
  evictDriftDbForScope: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { evictStoresForScope } from "../../../domains/workspaces/execution-store-cache.ts";
import { evictJobManagerForScope } from "../../../platform/jobs/job-manager.ts";
import { evictDriftDbForScope } from "../../../platform/storage/drift/drift-db-cache.ts";
import { createCanonServer } from "../../create-server.ts";
import {
  clearConnectionScope,
  clearSessionReady,
  getScopeForSession,
  hasOtherSessionsForDir,
} from "../../server-state.ts";
import {
  _injectSessionForTest,
  _resolveSessionScopeForTest,
  buildAllowedHosts,
  closeAllSessions,
  handleMcpRequest,
  sessionCount,
  teardownSession,
} from "../session-manager.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a real tmp dir on disk. */
function makeTmpDir(name: string): string {
  const d = path.join(tmpdir(), `sm-test-${name}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Narrow structural shape of the McpServer surface handleMcpRequest actually touches. */
type ServerMockShape = Pick<ReturnType<typeof createCanonServer>, "close" | "connect"> & {
  server: Pick<
    ReturnType<typeof createCanonServer>["server"],
    "listRoots" | "setNotificationHandler"
  >;
};

/** Build a minimal McpServer mock. */
function makeServerMock() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    server: {
      listRoots: vi.fn().mockResolvedValue({ roots: [] }),
      setNotificationHandler: vi.fn(),
    },
  };
}

/** Build a minimal IncomingMessage mock — headers only, the sole field handleMcpRequest reads. */
function makeReq(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as Pick<IncomingMessage, "headers"> as IncomingMessage;
}

/** Build a minimal ServerResponse mock exposing the two methods handleMcpRequest calls. */
function makeRes(): ServerResponse & { end: Mock; writeHead: Mock } {
  return { end: vi.fn(), writeHead: vi.fn() } as Pick<
    ServerResponse,
    "end" | "writeHead"
  > as ServerResponse & {
    end: Mock;
    writeHead: Mock;
  };
}

// ── Test setup/teardown ───────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  // Ensure clean state between tests
  await closeAllSessions();
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("sessionCount and closeAllSessions", () => {
  it("starts at zero", () => {
    expect(sessionCount()).toBe(0);
  });
});

describe("teardownSession — idempotency", () => {
  it("unknown session is a no-op", async () => {
    await teardownSession("non-existent-session");
    expect(vi.mocked(clearConnectionScope)).not.toHaveBeenCalled();
  });

  it("second teardownSession call is a no-op after first completes", async () => {
    const sessionId = "idem-session";
    vi.mocked(getScopeForSession).mockReturnValue(undefined);

    const serverMock = makeServerMock();
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    await teardownSession(sessionId);
    const callCountAfterFirst = vi.mocked(clearConnectionScope).mock.calls.length;

    // Second call should be a no-op (session already removed)
    await teardownSession(sessionId);
    expect(vi.mocked(clearConnectionScope).mock.calls.length).toBe(callCountAfterFirst);
  });
});

describe("teardownSession — teardown order (isolation-finish-01)", () => {
  it("fires in pinned sequence: clearConnectionScope → clearSessionReady → evict stores → evict drift → evict job manager", async () => {
    const dir = makeTmpDir("order-spy");
    const sessionId = "spy-session";

    vi.mocked(getScopeForSession).mockReturnValue(dir);
    vi.mocked(hasOtherSessionsForDir).mockReturnValue(false);

    const callOrder: string[] = [];
    vi.mocked(clearConnectionScope).mockImplementation(() => {
      callOrder.push("clearConnectionScope");
    });
    vi.mocked(clearSessionReady).mockImplementation(() => {
      callOrder.push("clearSessionReady");
    });
    vi.mocked(evictStoresForScope).mockImplementation(() => {
      callOrder.push("evictStoresForScope");
    });
    vi.mocked(evictDriftDbForScope).mockImplementation(() => {
      callOrder.push("evictDriftDbForScope");
    });
    vi.mocked(evictJobManagerForScope).mockImplementation(() => {
      callOrder.push("evictJobManagerForScope");
    });

    const serverMock = makeServerMock();
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    await teardownSession(sessionId);

    // Verify pinned order
    expect(callOrder[0]).toBe("clearConnectionScope");
    expect(callOrder[1]).toBe("clearSessionReady");
    expect(callOrder[2]).toBe("evictStoresForScope");
    expect(callOrder[3]).toBe("evictDriftDbForScope");
    expect(callOrder[4]).toBe("evictJobManagerForScope");

    // clearConnectionScope and clearSessionReady both called with sessionId
    expect(vi.mocked(clearConnectionScope)).toHaveBeenCalledWith(sessionId);
    expect(vi.mocked(clearSessionReady)).toHaveBeenCalledWith(sessionId);

    // Evictions called with dir
    expect(vi.mocked(evictStoresForScope)).toHaveBeenCalledWith(dir);
    expect(vi.mocked(evictDriftDbForScope)).toHaveBeenCalledWith(dir);
    expect(vi.mocked(evictJobManagerForScope)).toHaveBeenCalledWith(dir);

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });
});

describe("teardownSession — no evictions when dir unknown", () => {
  it("does not call eviction functions when getScopeForSession returns undefined", async () => {
    const sessionId = "no-scope-session";

    vi.mocked(getScopeForSession).mockReturnValue(undefined);

    const serverMock = makeServerMock();
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    await teardownSession(sessionId);

    expect(vi.mocked(evictStoresForScope)).not.toHaveBeenCalled();
    expect(vi.mocked(evictDriftDbForScope)).not.toHaveBeenCalled();
    expect(vi.mocked(evictJobManagerForScope)).not.toHaveBeenCalled();
    // But clearConnectionScope and clearSessionReady still called
    expect(vi.mocked(clearConnectionScope)).toHaveBeenCalledWith(sessionId);
    expect(vi.mocked(clearSessionReady)).toHaveBeenCalledWith(sessionId);
  });
});

describe("refcount guard — shared dir", () => {
  it("two sessions same dir: close first → NO evictions; close second → evictions fire once", async () => {
    const dir = makeTmpDir("refcount");
    const sessionA = "refcount-a";
    const sessionB = "refcount-b";

    const serverA = makeServerMock();
    const serverB = makeServerMock();
    _injectSessionForTest(
      sessionA,
      serverA as unknown as Parameters<typeof _injectSessionForTest>[1],
    );
    _injectSessionForTest(
      sessionB,
      serverB as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    // getScopeForSession returns dir for both
    vi.mocked(getScopeForSession).mockReturnValue(dir);
    // After closing A, B still present → hasOtherSessionsForDir returns true
    vi.mocked(hasOtherSessionsForDir).mockReturnValueOnce(true).mockReturnValue(false);

    // Close first session → no evictions (other session still using dir)
    await teardownSession(sessionA);
    expect(vi.mocked(evictStoresForScope)).not.toHaveBeenCalled();
    expect(vi.mocked(evictDriftDbForScope)).not.toHaveBeenCalled();
    expect(vi.mocked(evictJobManagerForScope)).not.toHaveBeenCalled();

    // Close second session → evictions fire exactly once
    await teardownSession(sessionB);
    expect(vi.mocked(evictStoresForScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(evictDriftDbForScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(evictJobManagerForScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(evictStoresForScope)).toHaveBeenCalledWith(dir);

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });
});

describe("refcount guard — distinct dirs", () => {
  it("close session for dirA → evictions for dirA only, not dirB", async () => {
    const dirA = makeTmpDir("distinct-a");
    const dirB = makeTmpDir("distinct-b");
    const sessionA = "distinct-a";
    const sessionB = "distinct-b";

    const serverA = makeServerMock();
    const serverB = makeServerMock();
    _injectSessionForTest(
      sessionA,
      serverA as unknown as Parameters<typeof _injectSessionForTest>[1],
    );
    _injectSessionForTest(
      sessionB,
      serverB as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    // A → dirA; hasOtherSessionsForDir is false (distinct dirs, no sharing)
    vi.mocked(getScopeForSession).mockReturnValueOnce(dirA);
    vi.mocked(hasOtherSessionsForDir).mockReturnValue(false);

    // Close session A
    await teardownSession(sessionA);
    expect(vi.mocked(evictStoresForScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(evictStoresForScope)).toHaveBeenCalledWith(dirA);
    expect(vi.mocked(evictStoresForScope)).not.toHaveBeenCalledWith(dirB);

    try {
      fs.rmdirSync(dirA);
    } catch {
      /* ignore */
    }
    try {
      fs.rmdirSync(dirB);
    } catch {
      /* ignore */
    }
  });
});

describe("closeAllSessions", () => {
  it("clears all sessions and returns to zero count", async () => {
    const serverA = makeServerMock();
    const serverB = makeServerMock();
    _injectSessionForTest(
      "close-all-a",
      serverA as unknown as Parameters<typeof _injectSessionForTest>[1],
    );
    _injectSessionForTest(
      "close-all-b",
      serverB as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    vi.mocked(getScopeForSession).mockReturnValue(undefined);

    expect(sessionCount()).toBe(2);
    await closeAllSessions();
    expect(sessionCount()).toBe(0);
  });
});

// ── handleMcpRequest — stale/unknown session (ADR-0053, dc-01/dc-03) ───────
//
// A restarted daemon wipes the in-memory `sessions` registry. A client that
// still holds a pre-restart `mcp-session-id` must get the spec-compliant
// 404 `-32001` "Session not found" (not the prior 400 "Server not
// initialized"), and must NOT trigger a throwaway createCanonServer()
// allocation. An `initialize` request (no session-id header) is unaffected.

describe("handleMcpRequest — stale/unknown session", () => {
  it("T1 (dc-01): unknown mcp-session-id → spec-compliant 404 -32001 'Session not found'", async () => {
    const req = makeReq({ "mcp-session-id": "stale-unknown-id" });
    const res = makeRes();

    await handleMcpRequest(req, res, 3142);

    expect(vi.mocked(res.writeHead)).toHaveBeenCalledWith(404, {
      "Content-Type": "application/json",
    });
    expect(vi.mocked(res.end)).toHaveBeenCalledTimes(1);
    const body = JSON.parse(res.end.mock.calls[0]?.[0] as string) as {
      jsonrpc: string;
      error: { code: number; message: string };
      id: null;
    };
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    });
  });

  it("T2 (dc-01, no-allocation): unknown session id never allocates createCanonServer()", async () => {
    const req = makeReq({ "mcp-session-id": "stale-unknown-id-2" });
    const res = makeRes();

    await handleMcpRequest(req, res, 3142);

    expect(vi.mocked(createCanonServer)).not.toHaveBeenCalled();
  });

  it("T3 (dc-03): no mcp-session-id header still takes the create-new-transport path (init path unchanged)", async () => {
    const handleRequestSpy = vi
      .spyOn(StreamableHTTPServerTransport.prototype, "handleRequest")
      .mockResolvedValue(undefined);
    vi.mocked(createCanonServer).mockReturnValue(
      makeServerMock() as ServerMockShape as ReturnType<typeof createCanonServer>,
    );

    const req = makeReq({});
    const res = makeRes();

    try {
      await handleMcpRequest(req, res, 3142);

      // No-header requests must reach the create-new-transport path — NOT the
      // stale-session 404 short-circuit.
      expect(vi.mocked(createCanonServer)).toHaveBeenCalledTimes(1);
      expect(handleRequestSpy).toHaveBeenCalledWith(req, res);
      expect(vi.mocked(res.writeHead)).not.toHaveBeenCalledWith(404, expect.anything());
    } finally {
      handleRequestSpy.mockRestore();
    }
  });
});

// W1–W4 hardening tests extracted to session-manager-hardening.test.ts
// (kept separate to stay within the 600-line limit per file)

// ── allowedHosts parity (contract-parity-across-layers) ────────────────────
//
// auth.ts accepts [::1] (via ALLOWED_HOSTS) and ::1 (via LOOPBACK_ADDRESSES).
// The SDK transport's allowedHosts must include the same IPv6 forms so that
// the two layers agree — a request that passes auth must also pass the SDK host
// check, and vice versa.

// ── CANON-SCOPE diagnostic log lines ──────────────────────────────────────

describe("CANON-SCOPE logging — header path", () => {
  it("emits source=header log line with raw and normalized dir when header resolves", async () => {
    const dir = makeTmpDir("scope-header");
    const sessionId = "scope-header-session";

    const serverMock = makeServerMock();
    const loggedLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      loggedLines.push(String(args[0]));
    });

    try {
      await _resolveSessionScopeForTest(sessionId, serverMock as never, dir);

      const headerLog = loggedLines.find(
        (s) => s.startsWith("CANON-SCOPE:") && s.includes("source=header"),
      );
      expect(headerLog).toBeDefined();
      expect(headerLog).toContain(`session=${sessionId.slice(0, 8)}`);
      expect(headerLog).toContain(`raw="${dir}"`);
      expect(headerLog).toMatch(/normalized="/);
    } finally {
      consoleSpy.mockRestore();
      try {
        fs.rmdirSync(dir);
      } catch {
        /* ignore */
      }
    }
  });
});

describe("CANON-SCOPE logging — roots-list path", () => {
  it("emits source=roots-list log line with uri and normalized dir when roots/list resolves", async () => {
    const { pathToFileURL } = await import("node:url");
    const dir = makeTmpDir("scope-roots");
    const sessionId = "scope-roots-session";

    const serverMock = makeServerMock();
    // listRoots returns the real dir as a file:// URI
    serverMock.server.listRoots = vi
      .fn()
      .mockResolvedValue({ roots: [{ uri: pathToFileURL(dir).href }] });

    const loggedLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      loggedLines.push(String(args[0]));
    });

    try {
      // No header dir — forces roots/list path
      await _resolveSessionScopeForTest(sessionId, serverMock as never, undefined);

      const rootsLog = loggedLines.find(
        (s) => s.startsWith("CANON-SCOPE:") && s.includes("source=roots-list"),
      );
      expect(rootsLog).toBeDefined();
      expect(rootsLog).toContain(`session=${sessionId.slice(0, 8)}`);
      expect(rootsLog).toMatch(/uri="file:\/\//);
      expect(rootsLog).toMatch(/normalized="/);
    } finally {
      consoleSpy.mockRestore();
      try {
        fs.rmdirSync(dir);
      } catch {
        /* ignore */
      }
    }
  });
});

describe("buildAllowedHosts — parity with auth.ts ALLOWED_HOSTS", () => {
  it("includes all IPv4 loopback forms (with and without port)", () => {
    const hosts = buildAllowedHosts(3142);
    expect(hosts).toContain("127.0.0.1");
    expect(hosts).toContain("127.0.0.1:3142");
    expect(hosts).toContain("localhost");
    expect(hosts).toContain("localhost:3142");
  });

  it("includes [::1] (bracketed) and [::1]:port to match auth.ts ALLOWED_HOSTS", () => {
    const hosts = buildAllowedHosts(3142);
    // auth.ts ALLOWED_HOSTS includes "[::1]" (extractHostname strips port suffix)
    // SDK does an exact includes() check on the raw Host header — both forms required
    expect(hosts).toContain("[::1]");
    expect(hosts).toContain("[::1]:3142");
  });

  it("reflects the chosen port in port-suffixed entries", () => {
    const hostsA = buildAllowedHosts(9001);
    const hostsB = buildAllowedHosts(9002);
    expect(hostsA).toContain("127.0.0.1:9001");
    expect(hostsA).not.toContain("127.0.0.1:9002");
    expect(hostsB).toContain("[::1]:9002");
    expect(hostsB).not.toContain("[::1]:9001");
  });
});
