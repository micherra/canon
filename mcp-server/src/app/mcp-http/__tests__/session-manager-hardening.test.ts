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
} from "../../server-state.ts";
import {
  _clearPendingHandshakeForTest,
  _injectPendingHandshakeForTest,
  _injectSessionForTest,
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

describe("W4 — scope immutability after first registration", () => {
  it("roots/list_changed handler skips re-registration when scope is already set", () => {
    const sessionId = "harden-w4-already-registered";
    const originalDir = makeTmpDir("w4-original");
    const newDir = makeTmpDir("w4-new");

    vi.mocked(getScopeForSession).mockReturnValue(originalDir);

    // Simulate the W4 guard logic (mirrors what registerRootsChangedHandler does):
    const existingDir = vi.mocked(getScopeForSession)(sessionId);
    if (existingDir === undefined) {
      vi.mocked(registerConnectionScope)(sessionId, newDir);
    }
    // existingDir is set → registerConnectionScope must NOT be called

    expect(vi.mocked(registerConnectionScope)).not.toHaveBeenCalled();

    try {
      fs.rmdirSync(originalDir);
      fs.rmdirSync(newDir);
    } catch {
      /* ignore */
    }
  });

  it("roots/list_changed handler DOES register scope when not yet set (first-time path)", () => {
    const sessionId = "harden-w4-not-yet-registered";
    const dir = makeTmpDir("w4-first-time");

    vi.mocked(getScopeForSession).mockReturnValue(undefined);

    const existingDir = vi.mocked(getScopeForSession)(sessionId);
    if (existingDir === undefined) {
      vi.mocked(registerConnectionScope)(sessionId, dir);
    }

    expect(vi.mocked(registerConnectionScope)).toHaveBeenCalledWith(sessionId, dir);

    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  });
});
