/**
 * Tests for the present_artifact tool.
 *
 * Covers:
 * - Returns INVALID_INPUT for unknown artifact type
 * - Returns INVALID_INPUT when compiled HTML doesn't exist
 * - Registers artifact and creates deferred decision; resolves on POST
 * - Cleans up artifact (via removeArtifact) after decision
 */

import { dirname as _dirname, join } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
import {
  registerArtifact,
  removeArtifact,
  resetStateForTesting,
  startHttpServer,
  stopHttpServer,
} from "@app/http-server.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { presentArtifact } from "../tools/present-artifact.ts";

// ---------------------------------------------------------------------------
// Mock child_process exec so no real browser is launched during tests
// ---------------------------------------------------------------------------

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: vi.fn((_cmd: string, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return {} as ReturnType<typeof actual.exec>;
    }),
    execFile: vi.fn((_file: string, _args: unknown, cb?: (err: Error | null) => void) => {
      if (typeof cb === "function") cb(null);
      return {} as ReturnType<typeof actual.execFile>;
    }),
  };
});

// ---------------------------------------------------------------------------
// readFile mock — controls HTML file resolution in present-artifact tool
//
// Three modes (per-test, reset in afterEach):
//   fakeHtmlPath + fakeHtmlContent — return fake HTML for the given path
//   simulateMissingHtml = true     — throw ENOENT for any .html path (simulates no dist build)
//   default                        — delegate to real fs (planning-brief.html in src/ui exists)
// ---------------------------------------------------------------------------

let fakeHtmlContent = "<html><head></head><body>Hello</body></html>";
let fakeHtmlPath: string | null = null;
let simulateMissingHtml = false;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (path: string, encoding?: string) => {
      if (simulateMissingHtml && typeof path === "string" && path.endsWith(".html")) {
        const err: NodeJS.ErrnoException = new Error(
          `ENOENT: no such file or directory, open '${path}'`,
        );
        err.code = "ENOENT";
        throw err;
      }
      if (fakeHtmlPath && path === fakeHtmlPath) {
        return encoding === "utf-8" ? fakeHtmlContent : Buffer.from(fakeHtmlContent);
      }
      return actual.readFile(
        path as Parameters<typeof actual.readFile>[0],
        encoding as BufferEncoding,
      );
    }),
  };
});

// ---------------------------------------------------------------------------
// Compute the expected HTML path in test mode.
// resolveUiDistDir() in the tool walks up 4 dirname levels from the tool source
// file and appends "src/ui". We replay the same logic here so fakeHtmlPath
// matches what the tool computes.
// ---------------------------------------------------------------------------

function getExpectedHtmlPath(artifactType: string): string {
  const toolFile = _fileURLToPath(new URL("../tools/present-artifact.ts", import.meta.url));
  const distDir = _dirname(_dirname(_dirname(_dirname(_dirname(toolFile)))));
  const VIEW_MAP: Record<string, string> = { "planning-brief": "planning-brief.html" };
  const htmlFileName = VIEW_MAP[artifactType];
  return join(distDir, "src", "ui", htmlFileName ?? "unknown.html");
}

// ---------------------------------------------------------------------------
// HTTP server lifecycle
// ---------------------------------------------------------------------------

const TEST_PORT = 13142;

beforeAll(async () => {
  await startHttpServer(TEST_PORT);
});

afterAll(async () => {
  await stopHttpServer();
});

afterEach(() => {
  resetStateForTesting();
  fakeHtmlPath = null;
  fakeHtmlContent = "<html><head></head><body>Hello</body></html>";
  simulateMissingHtml = false;
});

// ---------------------------------------------------------------------------
// Helper: POST a decision to resolve the pending deferred Promise
// ---------------------------------------------------------------------------

import { request as httpRequest } from "node:http";

function postDecision(
  type: string,
  slug: string,
  action: "approve" | "request_changes",
  annotations: unknown[] = [],
): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, annotations });
    const options = {
      headers: { "Content-Length": Buffer.byteLength(body), "Content-Type": "application/json" },
      hostname: "127.0.0.1",
      method: "POST",
      path: `/artifact/${type}/${slug}/decision`,
      port: TEST_PORT,
    };
    const req = httpRequest(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => resolve({ body: data, status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("presentArtifact — unknown artifact type", () => {
  it("returns INVALID_INPUT for an unknown type", async () => {
    const result = await presentArtifact({
      data: {},
      slug: "test-slug",
      type: "unknown-type",
      workspace: "/tmp/ws",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("unknown-type");
      expect(result.message).toContain("planning-brief");
    }
  });
});

describe("presentArtifact — compiled HTML missing", () => {
  it("returns INVALID_INPUT when the compiled HTML file is not found", async () => {
    // Simulate missing dist build by forcing ENOENT for any .html path
    simulateMissingHtml = true;

    const result = await presentArtifact({
      data: {},
      slug: "missing-html-slug",
      type: "planning-brief",
      workspace: "/tmp/ws",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("planning-brief");
      expect(result.message).toContain("Compiled HTML not found");
    }
  });
});

describe("presentArtifact — register artifact and create deferred decision", () => {
  it("registers artifact with http server and resolves when decision is posted", async () => {
    const slug = "plan-abc123";
    const type = "planning-brief";

    // Wire up fake HTML path so readFile mock returns our content
    fakeHtmlPath = getExpectedHtmlPath(type);
    fakeHtmlContent = "<html><head></head><body>Test</body></html>";

    // Start presentArtifact in background — it blocks until decision arrives
    const artifactPromise = presentArtifact({
      data: { planId: slug, sections: ["context"] },
      slug,
      type,
      workspace: "/tmp/ws",
    });

    // Give the server a moment to register the artifact before we POST the decision
    await new Promise<void>((r) => setTimeout(r, 50));

    // Confirm artifact is accessible (GET)
    const getRes = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          method: "GET",
          path: `/artifact/${type}/${slug}`,
          port: TEST_PORT,
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(getRes.status).toBe(200);

    // POST a decision to unblock presentArtifact
    const postRes = await postDecision(type, slug, "approve", [
      { itemIndex: 0, section: "context", text: "good" },
    ]);
    expect(postRes.status).toBe(200);

    // presentArtifact should now resolve
    const result = await artifactPromise;
    assertOk(result);
    expect(result.decision.action).toBe("approve");
    expect(result.decision.annotations).toHaveLength(1);
    expect(result.url).toContain(`/artifact/${type}/${slug}`);
  });

  it("resolves with request_changes action", async () => {
    const slug = "plan-changes-test";
    const type = "planning-brief";

    fakeHtmlPath = getExpectedHtmlPath(type);

    const artifactPromise = presentArtifact({
      data: { planId: slug },
      slug,
      type,
      workspace: "/tmp/ws",
    });

    await new Promise<void>((r) => setTimeout(r, 50));

    await postDecision(type, slug, "request_changes", []);

    const result = await artifactPromise;
    assertOk(result);
    expect(result.decision.action).toBe("request_changes");
    expect(result.decision.annotations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dynamic HTML path (html field provided)
// ---------------------------------------------------------------------------

describe("presentArtifact — dynamic HTML (html field provided)", () => {
  it("serves the provided HTML directly and resolves on decision POST", async () => {
    const slug = "test-dynamic";
    const type = "review-result";
    const providedHtml = "<html><head></head><body>Dynamic</body></html>";

    // Start presentArtifact in background — it blocks until decision arrives
    const artifactPromise = presentArtifact({
      data: { review: "data" },
      html: providedHtml,
      slug,
      type,
      workspace: "/tmp/ws",
    });

    // Give the server a moment to register the artifact before we POST
    await new Promise<void>((r) => setTimeout(r, 50));

    // Confirm artifact is accessible (GET returns 200)
    const getRes = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          method: "GET",
          path: `/artifact/${type}/${slug}`,
          port: TEST_PORT,
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(getRes.status).toBe(200);

    // POST a decision to unblock presentArtifact
    const postRes = await postDecision(type, slug, "approve", []);
    expect(postRes.status).toBe(200);

    // presentArtifact should now resolve with the decision
    const result = await artifactPromise;
    assertOk(result);
    expect(result.decision.action).toBe("approve");
    expect(result.url).toContain(`/artifact/${type}/${slug}`);
  });

  it("succeeds with an unknown type when html field is provided (no INVALID_INPUT error)", async () => {
    const slug = "custom-type-test";
    const type = "custom-type";
    const providedHtml = "<html><head></head><body>Custom</body></html>";

    const artifactPromise = presentArtifact({
      data: {},
      html: providedHtml,
      slug,
      type,
      workspace: "/tmp/ws",
    });

    await new Promise<void>((r) => setTimeout(r, 50));

    // POST decision to verify it resolves (not an INVALID_INPUT error)
    await postDecision(type, slug, "approve");
    const result = await artifactPromise;

    expect(result.ok).toBe(true);
  });

  it("cleans up dynamic HTML artifact after decision (404 on subsequent GET)", async () => {
    const slug = "dynamic-cleanup-test";
    const type = "review-result";
    const providedHtml = "<html><head></head><body>Cleanup Test</body></html>";

    const artifactPromise = presentArtifact({
      data: {},
      html: providedHtml,
      slug,
      type,
      workspace: "/tmp/ws",
    });

    await new Promise<void>((r) => setTimeout(r, 50));

    // POST decision and wait for resolution
    await postDecision(type, slug, "approve");
    await artifactPromise;

    // Artifact should be gone after cleanup
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          method: "GET",
          path: `/artifact/${type}/${slug}`,
          port: TEST_PORT,
        },
        (r) => {
          r.resume();
          r.on("end", () => resolve({ status: r.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(res.status).toBe(404);
  });
});

describe("presentArtifact — cleanup after decision", () => {
  it("removes artifact from http server after decision is received", async () => {
    const slug = "cleanup-test";
    const type = "planning-brief";

    fakeHtmlPath = getExpectedHtmlPath(type);

    const artifactPromise = presentArtifact({
      data: {},
      slug,
      type,
      workspace: "/tmp/ws",
    });

    await new Promise<void>((r) => setTimeout(r, 50));

    // POST decision to unblock
    await postDecision(type, slug, "approve");
    await artifactPromise;

    // After decision, the artifact should be gone from the server
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          method: "GET",
          path: `/artifact/${type}/${slug}`,
          port: TEST_PORT,
        },
        (r) => {
          r.resume();
          r.on("end", () => resolve({ status: r.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(res.status).toBe(404);
  });

  it("verifies removeArtifact clears the registered artifact from the http server", async () => {
    // Test that registerArtifact + removeArtifact lifecycle works as expected.
    // This verifies the http-server cleanup contract used by presentArtifact's finally block.
    const key = "planning-brief/manual-cleanup-test";
    registerArtifact(key, "<html><body></body></html>", {});

    const getRes1 = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          method: "GET",
          path: `/artifact/planning-brief/manual-cleanup-test`,
          port: TEST_PORT,
        },
        (r) => {
          r.resume();
          r.on("end", () => resolve({ status: r.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(getRes1.status).toBe(200);

    removeArtifact(key);

    const getRes2 = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          method: "GET",
          path: `/artifact/planning-brief/manual-cleanup-test`,
          port: TEST_PORT,
        },
        (r) => {
          r.resume();
          r.on("end", () => resolve({ status: r.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(getRes2.status).toBe(404);
  });
});
