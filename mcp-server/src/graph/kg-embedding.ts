/**
 * EmbeddingService
 *
 * Wraps @huggingface/transformers pipeline for feature extraction.
 * Lazy-loads the model on first use. Supports batch embedding and
 * explicit resource disposal.
 *
 * This service throws on errors (it is internal infrastructure,
 * not an MCP tool handler). Callers that need graceful degradation
 * should catch errors and return an appropriate ToolResult.
 */

import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { EMBEDDING_BATCH_SIZE, EMBEDDING_MODEL } from "../constants.ts";

// ---------------------------------------------------------------------------
// Pipeline factory — injectable for testing
// ---------------------------------------------------------------------------

/** Quantization dtype literal accepted by @huggingface/transformers pipeline options */
type QuantizationDtype = "auto" | "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16";

type PipelineFactory = (
  task: "feature-extraction",
  model: string,
  options: { dtype: QuantizationDtype },
) => Promise<FeatureExtractionPipeline>;

const defaultPipelineFactory: PipelineFactory = (task, model, options) =>
  // The @huggingface/transformers pipeline() overloads produce a union type too complex for
  // TypeScript to represent directly. Cast via unknown to extract the concrete type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
  pipeline(task as any, model, options as any) as unknown as Promise<FeatureExtractionPipeline>;

// ---------------------------------------------------------------------------
// EmbeddingService
// ---------------------------------------------------------------------------

export class EmbeddingService {
  private pipe: FeatureExtractionPipeline | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Injectable pipeline factory — used in tests to inject a mock.
   * Not part of the public API.
   */
  private _pipelineFactory: PipelineFactory = defaultPipelineFactory;

  /**
   * Lazy-load model on first use.
   * Concurrent calls share the same init promise (no double-load).
   */
  async init(): Promise<void> {
    if (this.pipe) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.pipe = await this._pipelineFactory("feature-extraction", EMBEDDING_MODEL, {
        dtype: "q8",
      });
    })();
    return this.initPromise;
  }

  /**
   * Embed a batch of texts.
   * Returns one Float32Array per input text, each of length EMBEDDING_DIM (384).
   * Processes in chunks of EMBEDDING_BATCH_SIZE to limit peak memory.
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.init();
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
      const output = await this.pipe!(batch, { pooling: "mean", normalize: true });
      // output is a Tensor with dims [batch_size, EMBEDDING_DIM].
      // Use _getitem(j) to extract the j-th row as a 1-D Tensor.
      // .data returns the underlying TypedArray for that row.
      for (let j = 0; j < batch.length; j++) {
        results.push(new Float32Array(output._getitem(j).data as Float32Array));
      }
    }
    return results;
  }

  /**
   * Embed a single text.
   * Convenience wrapper around embed().
   */
  async embedOne(text: string): Promise<Float32Array> {
    const [result] = await this.embed([text]);
    return result!;
  }

  /**
   * Free model resources.
   * After dispose(), the next embed() call will re-initialize the model.
   */
  dispose(): void {
    this.pipe = null;
    this.initPromise = null;
  }

  /**
   * Whether the model is currently loaded in memory.
   */
  get isLoaded(): boolean {
    return this.pipe !== null;
  }
}
