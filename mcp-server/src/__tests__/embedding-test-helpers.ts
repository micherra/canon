/**
 * Shared embedding test helpers.
 *
 * Provides a deterministic pseudo-random normalized 384-dim embedding function
 * and a MockEmbeddingService class for use across test files. Using these shared
 * utilities avoids copy-paste drift between test files.
 */

// ---------------------------------------------------------------------------
// randomEmbedding
// ---------------------------------------------------------------------------

/**
 * Returns a deterministic pseudo-random normalized 384-dim Float32Array.
 * Uses a simple LCG so the output is reproducible across runs for a given seed.
 */
export function randomEmbedding(seed = 0): Float32Array {
  const vec = new Float32Array(384);
  // Deterministic pseudo-random based on seed
  let s = seed + 1;
  for (let i = 0; i < 384; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    vec[i] = (s / 0xffffffff) * 2 - 1;
  }
  // L2 normalize
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) vec[i] /= norm;
  return vec;
}

// ---------------------------------------------------------------------------
// MockEmbeddingService
// ---------------------------------------------------------------------------

/**
 * Mock EmbeddingService that returns deterministic vectors without loading
 * any model. Suitable for use as a direct instance in tests that do not
 * require vi.mock (i.e. tests that accept an EmbeddingService parameter).
 */
export class MockEmbeddingService {
  private seed = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((_, i) => randomEmbedding(this.seed + i));
  }

  async embedOne(_text: string): Promise<Float32Array> {
    return randomEmbedding(this.seed++);
  }

  dispose(): void {
    /* no-op */
  }

  get isLoaded(): boolean {
    return false;
  }
}
