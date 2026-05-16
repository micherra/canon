/**
 * bridge-http.test.ts
 *
 * Tests for createHttpBridge() — the HTTP transport adapter.
 * Verifies that loadData reads from window.__CANON_DATA__, submitDecision
 * calls fetch with the correct URL and payload, init is a no-op, and missing
 * data/URL conditions throw with clear messages.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpBridge } from "../stores/bridge-http.js";

describe("createHttpBridge()", () => {
  // Save and restore window globals
  const originalCanonData = (globalThis as Record<string, unknown>).__CANON_DATA__;
  const originalCanonArtifactUrl = (globalThis as Record<string, unknown>).__CANON_ARTIFACT_URL__;

  afterEach(() => {
    // Restore window globals
    if (originalCanonData === undefined) {
      delete (globalThis as Record<string, unknown>).__CANON_DATA__;
    } else {
      (globalThis as Record<string, unknown>).__CANON_DATA__ = originalCanonData;
    }
    if (originalCanonArtifactUrl === undefined) {
      delete (globalThis as Record<string, unknown>).__CANON_ARTIFACT_URL__;
    } else {
      (globalThis as Record<string, unknown>).__CANON_ARTIFACT_URL__ = originalCanonArtifactUrl;
    }
    vi.restoreAllMocks();
  });

  describe("init()", () => {
    it("resolves immediately without side effects (no-op)", async () => {
      const bridge = createHttpBridge();
      await expect(bridge.init()).resolves.toBeUndefined();
    });

    it("can be called multiple times without error", async () => {
      const bridge = createHttpBridge();
      await bridge.init();
      await expect(bridge.init()).resolves.toBeUndefined();
    });
  });

  describe("loadData()", () => {
    it("returns the value at window.__CANON_DATA__", async () => {
      const data = { outcome: "GREENLIGHT", title: "My plan" };
      (globalThis as Record<string, unknown>).__CANON_DATA__ = data;

      const bridge = createHttpBridge();
      const result = await bridge.loadData<typeof data>();

      expect(result).toEqual(data);
    });

    it("returns nested objects correctly", async () => {
      const data = {
        acceptance_criteria: [],
        assumptions: [{ index: 0, text: "Assumption one" }],
      };
      (globalThis as Record<string, unknown>).__CANON_DATA__ = data;

      const bridge = createHttpBridge();
      const result = await bridge.loadData<typeof data>();

      expect(result).toEqual(data);
    });

    it("throws when window.__CANON_DATA__ is undefined", async () => {
      delete (globalThis as Record<string, unknown>).__CANON_DATA__;

      const bridge = createHttpBridge();

      await expect(bridge.loadData()).rejects.toThrow(
        "No embedded data found (window.__CANON_DATA__ is undefined)",
      );
    });

    it("returns falsy values (null, 0, false) if explicitly set", async () => {
      (globalThis as Record<string, unknown>).__CANON_DATA__ = null;

      const bridge = createHttpBridge();
      const result = await bridge.loadData();
      expect(result).toBeNull();
    });
  });

  describe("submitDecision()", () => {
    beforeEach(() => {
      (globalThis as Record<string, unknown>).__CANON_ARTIFACT_URL__ =
        "http://localhost:3456/artifact/planning-brief/my-slug";
    });

    it("POSTs the decision to {url}/decision with JSON body", async () => {
      const mockResponse = { ok: true, status: 200 } as Response;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

      const bridge = createHttpBridge();
      const decision = {
        action: "approve" as const,
        annotations: [],
      };

      await bridge.submitDecision(decision);

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:3456/artifact/planning-brief/my-slug/decision",
        {
          body: JSON.stringify(decision),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
    });

    it("POSTs request_changes decision with annotations and feedback", async () => {
      const mockResponse = { ok: true, status: 200 } as Response;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

      const bridge = createHttpBridge();
      const decision = {
        action: "request_changes" as const,
        annotations: [
          {
            itemIndex: 0,
            section: "assumptions",
            text: "This assumption is wrong",
            timestamp: "2026-05-11T10:00:00Z",
          },
        ],
        feedback: "Please reconsider the scope",
      };

      await bridge.submitDecision(decision);

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:3456/artifact/planning-brief/my-slug/decision",
        {
          body: JSON.stringify(decision),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
    });

    it("throws when window.__CANON_ARTIFACT_URL__ is undefined", async () => {
      delete (globalThis as Record<string, unknown>).__CANON_ARTIFACT_URL__;

      const bridge = createHttpBridge();
      const decision = { action: "approve" as const, annotations: [] };

      await expect(bridge.submitDecision(decision)).rejects.toThrow(
        "No artifact URL found (window.__CANON_ARTIFACT_URL__ is undefined)",
      );
    });

    it("throws when fetch response is not ok", async () => {
      const mockResponse = { ok: false, status: 422 } as Response;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

      const bridge = createHttpBridge();
      const decision = { action: "approve" as const, annotations: [] };

      await expect(bridge.submitDecision(decision)).rejects.toThrow(
        "Decision submission failed: 422",
      );
    });
  });

  describe("sendMessage()", () => {
    it("does not throw and logs a warning to console.warn", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const bridge = createHttpBridge();
      await expect(bridge.sendMessage("hello")).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("sendMessage is not supported in HTTP bridge mode"),
        "hello",
      );
    });

    it("resolves without returning a value", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const bridge = createHttpBridge();
      const result = await bridge.sendMessage("test message");

      expect(result).toBeUndefined();
    });
  });
});
