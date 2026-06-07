/**
 * session-manager-w5-race.test.ts — W5 register-after-teardown phantom scope race tests.
 *
 * Covers the race: teardownSession() fires while resolveSessionScope() is mid-await
 * (header realpath or roots/list retry). Without the guard, the in-flight completion
 * calls registerConnectionScope for a dead session → phantom scopeRegistry entry →
 * hasOtherSessionsForDir() forever returns true → stores eviction skipped indefinitely.
 *
 * Tests:
 * - W5a: header realpath path — teardown during realpath await → NO scope registered
 * - W5b: roots/list path — teardown during listRoots await → NO scope registered
 * - W5c: CANON-SCOPE session-closed-during-handshake log fires in both paths
 * - W5d: pendingHandshakes entry is cleaned up even when session was torn down
 *
 * TDD: these tests prove RED against the unguarded code, GREEN after the guard is applied.
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

// Mock node:fs/promises.realpath so we can control when it resolves (header path race)
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    realpath: vi.fn(original.realpath),
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { realpath as realpathMock } from "node:fs/promises";
import {
  getScopeForSession,
  hasOtherSessionsForDir,
  registerConnectionScope,
  resolveSessionReady,
} from "../../server-state.ts";
import {
  _injectSessionForTest,
  _resolveSessionScopeForTest,
  closeAllSessions,
  sessionCount,
  stopReaper,
  teardownSession,
} from "../session-manager.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(name: string): string {
  const d = path.join(tmpdir(), `sm-w5-${name}-${Date.now()}`);
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

/** Create a manually-resolvable promise for gating async operations. */
function makeDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ── Setup/teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no other sessions for dir, no scope registered
  vi.mocked(getScopeForSession).mockReturnValue(undefined);
  vi.mocked(hasOtherSessionsForDir).mockReturnValue(false);
});

afterEach(async () => {
  stopReaper();
  await closeAllSessions();
  vi.clearAllMocks();
});

// ── W5a: header realpath path race ────────────────────────────────────────

describe("W5a — header realpath race: teardown fires while realpath is awaited", () => {
  it("does NOT call registerConnectionScope for a dead session (header path)", async () => {
    const dir = makeTmpDir("w5a-header");
    const sessionId = "w5a-header-race";

    // Gate: realpath will not resolve until we release it
    const deferred = makeDeferred<string>();
    const realRealpathFn = fs.realpathSync.bind(fs);
    vi.mocked(realpathMock).mockImplementation(() => deferred.promise);

    // Inject session into registry AND start scope resolution (don't await yet)
    const serverMock = makeServerMock();
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    // Start resolution in the background (will block at realpath)
    const scopeResolutionPromise = _resolveSessionScopeForTest(sessionId, serverMock as never, dir);

    // Give the resolution a tick to reach the realpath await
    await new Promise((r) => setTimeout(r, 0));

    // Simulate teardown while realpath is still pending
    await teardownSession(sessionId);
    expect(sessionCount()).toBe(0);

    // Now release the realpath (resolution completes after session is gone)
    const canonicalDir = realRealpathFn(dir);
    deferred.resolve(canonicalDir);

    // Wait for the resolution to finish
    await scopeResolutionPromise;

    // KEY ASSERTION: registerConnectionScope must NOT have been called for the dead session
    expect(vi.mocked(registerConnectionScope)).not.toHaveBeenCalledWith(
      sessionId,
      expect.anything(),
    );
    // resolveSessionReady must NOT have been called for the dead session
    expect(vi.mocked(resolveSessionReady)).not.toHaveBeenCalledWith(sessionId);

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });
});

// ── W5b: roots/list path race ─────────────────────────────────────────────

describe("W5b — roots/list race: teardown fires while listRoots is awaited", () => {
  it("does NOT call registerConnectionScope for a dead session (roots/list path)", async () => {
    const dir = makeTmpDir("w5b-roots");
    const sessionId = "w5b-roots-race";

    // Gate: listRoots will not resolve until we release it
    const deferred = makeDeferred<{ roots: { uri: string }[] }>();

    const serverMock = makeServerMock();
    // No header dir → falls through to roots/list
    serverMock.server.listRoots.mockReturnValue(deferred.promise);

    // Inject session and start resolution (no header → roots/list path)
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );
    const scopeResolutionPromise = _resolveSessionScopeForTest(
      sessionId,
      serverMock as never,
      undefined, // no header → Layer b
    );

    // Give the resolution a tick to reach the listRoots await
    await new Promise((r) => setTimeout(r, 0));

    // Simulate teardown while listRoots is still pending
    await teardownSession(sessionId);
    expect(sessionCount()).toBe(0);

    // Release listRoots with a valid dir result
    deferred.resolve({ roots: [{ uri: pathToFileURL(dir).href }] });

    // Wait for resolution to complete
    await scopeResolutionPromise;

    // KEY ASSERTION: registerConnectionScope must NOT have been called for the dead session
    expect(vi.mocked(registerConnectionScope)).not.toHaveBeenCalledWith(
      sessionId,
      expect.anything(),
    );
    expect(vi.mocked(resolveSessionReady)).not.toHaveBeenCalledWith(sessionId);

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });
});

// ── W5c: CANON-SCOPE session-closed log fires ─────────────────────────────

describe("W5c — session-closed-during-handshake log fires on race", () => {
  it("emits reason=session-closed-during-handshake log on header path race", async () => {
    const dir = makeTmpDir("w5c-header-log");
    const sessionId = "w5c-log-header";

    const deferred = makeDeferred<string>();
    vi.mocked(realpathMock).mockImplementation(() => deferred.promise);

    const serverMock = makeServerMock();
    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    const loggedLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      loggedLines.push(String(s));
      return true;
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      loggedLines.push(String(args[0]));
    });

    const scopeResolutionPromise = _resolveSessionScopeForTest(sessionId, serverMock as never, dir);

    await new Promise((r) => setTimeout(r, 0));
    await teardownSession(sessionId);

    const canonicalDir = fs.realpathSync(dir);
    deferred.resolve(canonicalDir);

    await scopeResolutionPromise;

    stderrSpy.mockRestore();
    consoleSpy.mockRestore();

    // CANON-SCOPE line with reason=session-closed-during-handshake must be emitted
    const closedLog = loggedLines.find(
      (s) => s.includes("CANON-SCOPE:") && s.includes("session-closed-during-handshake"),
    );
    expect(closedLog).toBeDefined();

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });

  it("emits reason=session-closed-during-handshake log on roots/list path race", async () => {
    const dir = makeTmpDir("w5c-roots-log");
    const sessionId = "w5c-log-roots";

    const deferred = makeDeferred<{ roots: { uri: string }[] }>();
    const serverMock = makeServerMock();
    serverMock.server.listRoots.mockReturnValue(deferred.promise);

    _injectSessionForTest(
      sessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    const loggedLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      loggedLines.push(String(s));
      return true;
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      loggedLines.push(String(args[0]));
    });

    const scopeResolutionPromise = _resolveSessionScopeForTest(
      sessionId,
      serverMock as never,
      undefined,
    );

    await new Promise((r) => setTimeout(r, 0));
    await teardownSession(sessionId);

    deferred.resolve({ roots: [{ uri: pathToFileURL(dir).href }] });
    await scopeResolutionPromise;

    stderrSpy.mockRestore();
    consoleSpy.mockRestore();

    const closedLog = loggedLines.find(
      (s) => s.includes("CANON-SCOPE:") && s.includes("session-closed-during-handshake"),
    );
    expect(closedLog).toBeDefined();

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });
});

// ── W5d: pendingHandshakes entry cleaned up on race ───────────────────────

describe("W5d — pendingHandshakes entry cleaned up when session torn down during handshake", () => {
  it("hasOtherSessionsForDir returns false after race resolution (no phantom pending entry)", async () => {
    // After the race: session dead, scope NOT registered, pendingHandshakes cleared.
    // A subsequent teardown of an unrelated session for the same dir must NOT
    // see a phantom pending-handshake entry blocking eviction.
    const dir = makeTmpDir("w5d-cleanup");
    const racingSessionId = "w5d-racing";
    const unrelatedSessionId = "w5d-unrelated";

    // Gate for the racing session
    const deferred = makeDeferred<{ roots: { uri: string }[] }>();
    const serverMock = makeServerMock();
    serverMock.server.listRoots.mockReturnValue(deferred.promise);

    _injectSessionForTest(
      racingSessionId,
      serverMock as unknown as Parameters<typeof _injectSessionForTest>[1],
    );

    // Start the racing resolution
    const scopeResolutionPromise = _resolveSessionScopeForTest(
      racingSessionId,
      serverMock as never,
      undefined,
    );

    await new Promise((r) => setTimeout(r, 0));

    // Teardown the racing session
    await teardownSession(racingSessionId);

    // Release the deferred (completes with dir)
    deferred.resolve({ roots: [{ uri: pathToFileURL(dir).href }] });
    await scopeResolutionPromise;

    // Now inject an unrelated session for the same dir and tear it down.
    // The key: pendingHandshakes must be clean after the race, so eviction fires.
    const serverB = makeServerMock();
    _injectSessionForTest(
      unrelatedSessionId,
      serverB as unknown as Parameters<typeof _injectSessionForTest>[1],
    );
    vi.mocked(getScopeForSession).mockReturnValue(dir);
    vi.mocked(hasOtherSessionsForDir).mockReturnValue(false);

    const { evictStoresForScope } = await import(
      "../../../domains/workspaces/execution-store-cache.ts"
    );

    await teardownSession(unrelatedSessionId);

    // Eviction must fire — no phantom pending entry blocking it
    expect(vi.mocked(evictStoresForScope)).toHaveBeenCalledWith(dir);

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });
});
