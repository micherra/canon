/**
 * session-manager-hardening.test.ts — adversarial-review hardening tests (W1–W4).
 *
 * Extracted from session-manager.test.ts to keep files within the 600-line limit.
 *
 * Covers:
 * - W1: Idle-session reaper (runReaperSweep, startReaper, stopReaper)
 * - W2: Teardown order — server.close completes BEFORE eviction chain (W2 fix)
 * - W3: Pending-handshake registry blocks premature eviction
 * - W4: Scope immutability — roots/list_changed cannot override registered scope
 */

import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks (must precede module imports) ──────────────────────────────

vi.mock("../../create-server.ts", () => ({
  createCanonServer: vi.fn(),
}));

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
  };
});

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
import {
  clearConnectionScope,
  getScopeForSession,
  hasOtherSessionsForDir,
  registerConnectionScope,
  resolveSessionReady,
} from "../../server-state.ts";
import {
  _clearPendingHandshakeForTest,
  _injectPendingHandshakeForTest,
  _injectSessionForTest,
  _registerRootsChangedHandlerForTest,
  closeAllSessions,
  runReaperSweep,
  sessionCount,
  startReaper,
  stopReaper,
  teardownSession,
} from "../session-manager.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(name: string): string {
  const d = path.join(tmpdir(), `sm-harden-${name}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

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

// ── Setup/teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  stopReaper();
  await closeAllSessions();
  vi.clearAllMocks();
});

// ── W1: idle-session reaper ────────────────────────────────────────────────

describe("W1 — idle-session reaper", () => {
  it("runReaperSweep tears down sessions idle past the TTL", async () => {
    const sessionId = "harden-idle-past-ttl";
    vi.mocked(getScopeForSession).mockReturnValue(undefined);
    vi.mocked(hasOtherSessionsForDir).mockReturnValue(false);

    const serverMock = makeServerMock();
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
      Date.now() - 2 * 60 * 60 * 1000, // 2 hours idle
    );

    expect(sessionCount()).toBe(1);
    process.env.CANON_HTTP_SESSION_TTL_MS = String(60 * 1000); // 1 min TTL
    try {
      runReaperSweep();
    } finally {
      delete process.env.CANON_HTTP_SESSION_TTL_MS;
    }

    await new Promise((r) => setTimeout(r, 10));
    expect(sessionCount()).toBe(0);
  });

  it("runReaperSweep does NOT tear down sessions within the TTL", async () => {
    const sessionId = "harden-within-ttl";
    vi.mocked(getScopeForSession).mockReturnValue(undefined);
    vi.mocked(hasOtherSessionsForDir).mockReturnValue(false);

    const serverMock = makeServerMock();
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
      Date.now(), // just now
    );

    process.env.CANON_HTTP_SESSION_TTL_MS = String(60 * 1000);
    try {
      runReaperSweep();
    } finally {
      delete process.env.CANON_HTTP_SESSION_TTL_MS;
    }

    await new Promise((r) => setTimeout(r, 10));
    expect(sessionCount()).toBe(1);
  });

  it("startReaper/stopReaper are idempotent", () => {
    startReaper();
    startReaper();
    stopReaper();
    stopReaper();
    expect(sessionCount()).toBe(0);
  });

  it("closeAllSessions stops the reaper (no leaked timers)", async () => {
    startReaper();
    const serverMock = makeServerMock();
    _injectSessionForTest(
      "harden-close-all-reaper",
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );
    vi.mocked(getScopeForSession).mockReturnValue(undefined);

    await closeAllSessions();
    stopReaper(); // idempotent — reaper already stopped
    expect(sessionCount()).toBe(0);
  });
});

// ── W2: teardown order — server.close before evictions ────────────────────

describe("W2 — teardown drains server before evicting stores", () => {
  it("server.close is called before eviction functions in the teardown sequence", async () => {
    const dir = makeTmpDir("w2-order");
    const sessionId = "harden-w2-session";

    vi.mocked(getScopeForSession).mockReturnValue(dir);
    vi.mocked(hasOtherSessionsForDir).mockReturnValue(false);

    const callOrder: string[] = [];

    const serverMock = makeServerMock();
    serverMock.close.mockImplementation(async () => {
      callOrder.push("server.close");
    });

    vi.mocked(clearConnectionScope).mockImplementation(() => {
      callOrder.push("clearConnectionScope");
    });
    vi.mocked(evictStoresForScope).mockImplementation(() => {
      callOrder.push("evictStoresForScope");
    });

    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    await teardownSession(sessionId);

    expect(callOrder[0]).toBe("server.close");
    expect(callOrder).toContain("clearConnectionScope");
    expect(callOrder).toContain("evictStoresForScope");
    const serverCloseIdx = callOrder.indexOf("server.close");
    const evictIdx = callOrder.indexOf("evictStoresForScope");
    expect(serverCloseIdx).toBeLessThan(evictIdx);

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });
});

// ── W3: pending handshake prevents premature eviction ─────────────────────

describe("W3 — pending handshake prevents premature eviction", () => {
  it("session A closes while session B is mid-handshake for the same dir → NO eviction", async () => {
    const dir = makeTmpDir("w3-window");
    const sessionA = "harden-w3-session-a";
    const sessionB = "harden-w3-session-b";

    vi.mocked(getScopeForSession).mockReturnValue(dir);
    vi.mocked(hasOtherSessionsForDir).mockReturnValue(false);

    const serverA = makeServerMock();
    _injectSessionForTest(
      sessionA,
      serverA as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    _injectPendingHandshakeForTest(sessionB, dir);

    await teardownSession(sessionA);

    expect(vi.mocked(evictStoresForScope)).not.toHaveBeenCalled();
    expect(vi.mocked(evictDriftDbForScope)).not.toHaveBeenCalled();
    expect(vi.mocked(evictJobManagerForScope)).not.toHaveBeenCalled();

    _clearPendingHandshakeForTest(sessionB);

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });

  it("session A closes with NO pending handshakes → eviction fires normally", async () => {
    const dir = makeTmpDir("w3-no-pending");
    const sessionId = "harden-w3-only-session";

    vi.mocked(getScopeForSession).mockReturnValue(dir);
    vi.mocked(hasOtherSessionsForDir).mockReturnValue(false);

    const serverMock = makeServerMock();
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    await teardownSession(sessionId);

    expect(vi.mocked(evictStoresForScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(evictStoresForScope)).toHaveBeenCalledWith(dir);

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });

  it("symlinked-dir variant: hint normalized to realpath matches teardown realpath → guard holds (N3)", async () => {
    // N3 bug class: header like /var/folders/... resolves to /private/var/folders/... via realpath.
    // The registered scope (from validateAndNormalizeDir) is always in realpath form.
    // The pending-handshake hint must ALSO be in realpath form for hasPendingHandshakeForDir
    // to match — otherwise the guard is defeated and eviction fires prematurely.
    //
    // This test uses the symlink that macOS exposes via os.tmpdir():
    //   tmpdir() → /var/folders/... (symlink path)
    //   realpath  → /private/var/folders/... (canonical path)
    // We simulate: session A closes for `realpathDir`; session B is mid-handshake
    // with hint already normalized to `realpathDir` (what N3 ensures).
    const rawDir = makeTmpDir("w3-symlink");
    const realpathDir = fs.realpathSync(rawDir); // /private/var/... on macOS

    // Guard only has bite when raw != realpath (symlink present)
    if (rawDir === realpathDir) {
      // Not on a symlinked-tmp system; skip body — guard still passes trivially.
      return;
    }

    const sessionA = "harden-w3-symlink-a";
    const sessionB = "harden-w3-symlink-b";

    // Session A's scope is the realpath form (as registered by validateAndNormalizeDir)
    vi.mocked(getScopeForSession).mockReturnValue(realpathDir);
    vi.mocked(hasOtherSessionsForDir).mockReturnValue(false);

    const serverA = makeServerMock();
    _injectSessionForTest(
      sessionA,
      serverA as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    // Session B has its hint normalized to realpathDir (N3 fix ensures this)
    _injectPendingHandshakeForTest(sessionB, realpathDir);

    await teardownSession(sessionA);

    // Guard holds: realpathDir hint matches realpathDir scope → eviction blocked
    expect(vi.mocked(evictStoresForScope)).not.toHaveBeenCalled();
    expect(vi.mocked(evictDriftDbForScope)).not.toHaveBeenCalled();
    expect(vi.mocked(evictJobManagerForScope)).not.toHaveBeenCalled();

    _clearPendingHandshakeForTest(sessionB);
    try {
      fs.rmdirSync(rawDir);
    } catch {
      /* ignore */
    }
  });

  it("unknown-hint pending handshake conservatively blocks eviction", async () => {
    const dir = makeTmpDir("w3-unknown-hint");
    const sessionId = "harden-w3-known";
    const pendingId = "harden-w3-pending-unknown";

    vi.mocked(getScopeForSession).mockReturnValue(dir);
    vi.mocked(hasOtherSessionsForDir).mockReturnValue(false);

    const serverMock = makeServerMock();
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    _injectPendingHandshakeForTest(pendingId, "unknown");

    await teardownSession(sessionId);

    expect(vi.mocked(evictStoresForScope)).not.toHaveBeenCalled();

    _clearPendingHandshakeForTest(pendingId);

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });
});

// ── W4: scope immutability after first registration ────────────────────────
//
// These tests drive the REAL registerRootsChangedHandler (via the exported test
// helper _registerRootsChangedHandlerForTest). The handler is captured from the
// setNotificationHandler mock call, then invoked directly. This ensures the tests
// will FAIL if the production guard in session-manager.ts is deleted — the prior
// tests re-implemented the guard inline and were therefore green-but-unverified
// mock-theater (N1 finding from Fix Verification cycle 2).

describe("W4 — scope immutability after first registration", () => {
  /**
   * Build a minimal transport-like object that provides the `sessionId` property
   * the real registerRootsChangedHandler closure reads.
   */
  function makeTransportStub(sessionId: string) {
    return { sessionId } as unknown as Parameters<typeof _registerRootsChangedHandlerForTest>[1];
  }

  /**
   * Register the real handler and extract the async callback from the
   * setNotificationHandler mock call.
   */
  function captureRootsChangedHandler(
    serverMock: ReturnType<typeof makeServerMock>,
    sessionId: string,
  ): () => Promise<void> {
    const transportStub = makeTransportStub(sessionId);
    _registerRootsChangedHandlerForTest(
      serverMock as unknown as Parameters<typeof _registerRootsChangedHandlerForTest>[0],
      transportStub,
    );
    // The real registerRootsChangedHandler calls server.server.setNotificationHandler
    // with (schema, handler). Capture the handler from the mock call.
    const calls = vi.mocked(serverMock.server.setNotificationHandler).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const handler = calls[calls.length - 1][1] as () => Promise<void>;
    return handler;
  }

  it("roots/list_changed handler skips re-registration when scope is already set — drives REAL handler", async () => {
    const sessionId = "harden-w4-real-already-registered";
    const originalDir = makeTmpDir("w4-real-original");
    const newDir = makeTmpDir("w4-real-new");

    // Inject a real session so the handler's `sessions.get(sid)` check passes
    const serverMock = makeServerMock();
    // listRoots returns a new dir (simulating that roots changed).
    // Use pathToFileURL to produce a properly-formed file:// URI (e.g. file:///private/tmp/...)
    // that fileURLToPath inside tryRootsList can correctly parse.
    serverMock.server.listRoots.mockResolvedValue({
      roots: [{ uri: pathToFileURL(newDir).href }],
    });
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    // Scope already registered for this session
    vi.mocked(getScopeForSession).mockReturnValue(originalDir);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const handler = captureRootsChangedHandler(serverMock, sessionId);

    // Invoke the real handler — it should detect the existing scope and return early
    await handler();

    // Guard assertion: registerConnectionScope must NOT be called
    // (removing the W4 guard in session-manager.ts causes this to fail)
    expect(vi.mocked(registerConnectionScope)).not.toHaveBeenCalled();

    // Guard assertion: stderr immutability line must be emitted when dir differs
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const immutableLogEmitted = stderrCalls.some(
      (s) => s.includes("scope is immutable after first registration") && s.includes(sessionId),
    );
    expect(immutableLogEmitted).toBe(true);

    stderrSpy.mockRestore();
    try {
      fs.rmdirSync(originalDir);
      fs.rmdirSync(newDir);
    } catch {
      /* ignore */
    }
  });

  it("roots/list_changed handler DOES register scope when not yet set (first-time path) — drives REAL handler", async () => {
    const sessionId = "harden-w4-real-first-time";
    const dir = makeTmpDir("w4-real-first");
    // validateAndNormalizeDir uses fs.realpath, so the registered scope will be the
    // realpath-normalized form (e.g. /private/var/... on macOS). Pre-compute it.
    const realpathDir = fs.realpathSync(dir);

    const serverMock = makeServerMock();
    serverMock.server.listRoots.mockResolvedValue({
      roots: [{ uri: pathToFileURL(dir).href }],
    });
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    // No scope registered yet
    vi.mocked(getScopeForSession).mockReturnValue(undefined);

    const handler = captureRootsChangedHandler(serverMock, sessionId);

    await handler();

    // First-time path: scope should be registered with the realpath-normalized dir.
    // registerConnectionScope is called by the real handler with the validated+normalized path.
    expect(vi.mocked(registerConnectionScope)).toHaveBeenCalledWith(sessionId, realpathDir);
    expect(vi.mocked(resolveSessionReady)).toHaveBeenCalledWith(sessionId);

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });
});
