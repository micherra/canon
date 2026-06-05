/**
 * EmbeddingService Tests
 *
 * Tests for lazy model loading, batch embedding, single embedding,
 * dispose lifecycle, and dimension correctness.
 *
 * NOTE: These tests download the Xenova/all-MiniLM-L6-v2 model (~22MB) on first run.
 * They are marked with a 60s timeout to accommodate the download.
 * In CI, the model is cached after the first run.
 *
 * The "real embeddings" suite skips gracefully when the model CDN is unreachable
 * (e.g. HTTP 429, ENOTFOUND). It runs in full when the model is cached locally.
 */

import { EmbeddingService } from "@graph/kg-embedding.ts";
import { EMBEDDING_BATCH_SIZE, EMBEDDING_DIM } from "@shared/constants.ts";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// isNetworkError — pure helper, file scope is fine for a stateless classifier.
//
// Returns true when the error looks like a CDN/network availability failure.
// Only network/availability errors trigger suite skip. Any error that originates
// from within a running test (assertion failures, logic errors) still fails
// normally — the probe only guards the initial model load.
// ---------------------------------------------------------------------------

/** Returns true when the error looks like a CDN/network availability failure. */
function isNetworkError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("failed to fetch") ||
    msg.includes("load file") // huggingface "Error (NNN) occurred while trying to load file:"
  );
}

/** Create a real EmbeddingService instance for lifecycle tests (no model download). */
function makeService(): EmbeddingService {
  return new EmbeddingService();
}

// Lifecycle tests (no model download — use mocks)

describe("EmbeddingService — lifecycle (mocked pipeline)", () => {
  let service: EmbeddingService;

  beforeEach(() => {
    service = makeService();
  });

  afterEach(() => {
    service.dispose();
  });

  test("isLoaded is false before first embed call", () => {
    expect(service.isLoaded).toBe(false);
  });

  test("dispose() clears model; isLoaded returns false", () => {
    // Manually poke the private field to simulate loaded state
    (service as any).pipe = {}; // simulate a loaded pipe
    expect(service.isLoaded).toBe(true);
    service.dispose();
    expect(service.isLoaded).toBe(false);
    expect((service as any).initPromise).toBeNull();
  });

  test("concurrent init() calls do not double-load the model", async () => {
    let resolveInit!: () => void;
    const initBarrier = new Promise<void>((res) => {
      resolveInit = res;
    });

    let callCount = 0;
    const mockPipeline = vi.fn().mockImplementation(async () => {
      callCount++;
      await initBarrier;
      return { mockPipe: true } as never;
    });

    // Inject mock pipeline factory
    (service as any)._pipelineFactory = mockPipeline;

    // Start two concurrent inits before the first one resolves
    const p1 = service.init();
    const p2 = service.init();

    // The initPromise should be set after the first call
    expect((service as any).initPromise).not.toBeNull();

    resolveInit();
    await Promise.all([p1, p2]);

    // Pipeline factory was only called once despite two concurrent init() calls
    expect(callCount).toBe(1);
  });

  test("init() is idempotent when already loaded", async () => {
    // Simulate already loaded
    (service as any).pipe = { mockPipe: true };
    let called = false;
    (service as any)._pipelineFactory = vi.fn().mockImplementation(async () => {
      called = true;
      return {};
    });

    await service.init();
    expect(called).toBe(false); // factory not called when pipe already set
  });
});

// Embedding correctness tests (require real model download)
//
// These tests run the real Xenova/all-MiniLM-L6-v2 model (~22 MB download).
// The availability probe lives INSIDE this describe block so that selecting
// only lifecycle/unit tests (e.g. `vitest ... -t "lifecycle"`) never triggers
// a model download. The probe's beforeAll is only registered when the
// real-embeddings describe is collected.
//
// Skip precision: only network/CDN errors (429, ENOTFOUND, fetch failures)
// cause the suite to skip via isNetworkError. A genuine assertion/logic/model
// error re-throws so the suite fails loudly rather than silently hiding a
// real bug. A 429 / offline environment produces SKIP, not FAIL.

describe("EmbeddingService — real embeddings", { timeout: 120_000 }, () => {
  let service: EmbeddingService;
  let modelUnavailable = false;

  // ---------------------------------------------------------------------------
  // Availability probe — registered INSIDE this describe so it only runs when
  // this suite is selected. Selecting only the lifecycle suite above will NOT
  // trigger this beforeAll or any model download.
  // ---------------------------------------------------------------------------
  beforeAll(async () => {
    const probe = new EmbeddingService();
    try {
      await probe.embedOne("warmup");
    } catch (err) {
      if (err instanceof Error && isNetworkError(err)) {
        // CDN/network unreachable — skip the real-embeddings suite, not a test failure.
        console.warn(
          `[kg-embedding] real-embeddings suite skipped: model unavailable (${err.message.slice(0, 120)})`,
        );
        modelUnavailable = true;
      } else {
        // Unexpected non-network error during probe — re-throw so the suite fails
        // loudly rather than silently skipping a genuine bug.
        throw err;
      }
    } finally {
      probe.dispose();
    }
  }, 120_000);

  beforeEach((ctx) => {
    if (modelUnavailable) ctx.skip();
    service = new EmbeddingService();
  });

  afterEach(() => {
    service?.dispose();
  });

  test("embedOne() returns Float32Array of length EMBEDDING_DIM (384)", async () => {
    const result = await service.embedOne("Hello world");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(EMBEDDING_DIM);
    expect(result.length).toBe(384);
  });

  test("embed() returns correct number of Float32Arrays", async () => {
    const texts = ["first sentence", "second sentence", "third sentence"];
    const results = await service.embed(texts);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(EMBEDDING_DIM);
    }
  });

  test("embed() with empty array returns empty array", async () => {
    const results = await service.embed([]);
    expect(results).toHaveLength(0);
  });

  test("isLoaded is true after first embed()", async () => {
    expect(service.isLoaded).toBe(false);
    await service.embedOne("test");
    expect(service.isLoaded).toBe(true);
  });

  test("dispose() then embed() re-initializes model", async () => {
    await service.embedOne("load model");
    expect(service.isLoaded).toBe(true);

    service.dispose();
    expect(service.isLoaded).toBe(false);

    // Re-embed should work without error
    const result = await service.embedOne("reload model");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(EMBEDDING_DIM);
    expect(service.isLoaded).toBe(true);
  });

  test("embeddings are normalized (L2 norm ≈ 1.0)", async () => {
    const vec = await service.embedOne("normalize test");
    const sumSq = vec.reduce((acc, v) => acc + v * v, 0);
    const norm = Math.sqrt(sumSq);
    // Should be very close to 1.0 (within floating point tolerance)
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
  });

  test("batch processing respects EMBEDDING_BATCH_SIZE boundary", async () => {
    // Create texts that exceed one batch
    const texts = Array.from(
      { length: EMBEDDING_BATCH_SIZE + 2 },
      (_, i) => `sentence number ${i}`,
    );
    const results = await service.embed(texts);
    expect(results).toHaveLength(EMBEDDING_BATCH_SIZE + 2);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(EMBEDDING_DIM);
    }
  });

  test("identical texts produce identical embeddings", async () => {
    const text = "deterministic embedding test";
    const [v1, v2] = await service.embed([text, text]);
    // Same text should produce same vector
    expect(v1.length).toBe(v2.length);
    for (let i = 0; i < v1.length; i++) {
      expect(v1[i]).toBeCloseTo(v2[i]!, 5);
    }
  });
});
