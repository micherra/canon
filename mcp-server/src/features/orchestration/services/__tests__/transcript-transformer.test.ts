import { describe, expect, it } from "vitest";
import type { ClaudeCodeEntry } from "../transcript-transformer.ts";
import { aggregateCacheUsage, transformClaudeCodeTranscript } from "../transcript-transformer.ts";

// Cache hit/miss token telemetry (dc-01, dc-02) — see
// plans/cache-hitmiss-token-telemetry-stop-discarding/cache-telemetry-01-PLAN.md

describe("transformClaudeCodeTranscript — cache field propagation (dc-01)", () => {
  it("propagates cache_read_input_tokens onto the assistant TranscriptEntry as cache_read_tokens", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        message: {
          content: "Working on it.",
          role: "assistant",
          usage: { cache_read_input_tokens: 100, output_tokens: 10 },
        },
        timestamp: "2026-07-02T00:00:00.000Z",
        type: "assistant",
      },
    ];

    const [entry] = transformClaudeCodeTranscript(entries);

    expect(entry.cache_read_tokens).toBe(100);
  });

  it("propagates cache_creation_input_tokens onto the assistant TranscriptEntry as cache_creation_tokens", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        message: {
          content: "Working on it.",
          role: "assistant",
          usage: { cache_creation_input_tokens: 42, output_tokens: 10 },
        },
        timestamp: "2026-07-02T00:00:00.000Z",
        type: "assistant",
      },
    ];

    const [entry] = transformClaudeCodeTranscript(entries);

    expect(entry.cache_creation_tokens).toBe(42);
  });

  it("propagates both cache fields for array-content (text block) assistant entries", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        message: {
          content: [{ text: "Let me check.", type: "text" }],
          role: "assistant",
          usage: { cache_creation_input_tokens: 5, cache_read_input_tokens: 200, output_tokens: 8 },
        },
        timestamp: "2026-07-02T00:00:00.000Z",
        type: "assistant",
      },
    ];

    const [entry] = transformClaudeCodeTranscript(entries);

    expect(entry.role).toBe("assistant");
    expect(entry.cache_read_tokens).toBe(200);
    expect(entry.cache_creation_tokens).toBe(5);
  });

  it("propagates cache fields onto the first emitted entry when array content is tool_use-only (Codex P2)", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        message: {
          content: [{ input: { file_path: "/foo.ts" }, name: "Read", type: "tool_use" }],
          role: "assistant",
          usage: {
            cache_creation_input_tokens: 15,
            cache_read_input_tokens: 300,
            output_tokens: 8,
          },
        },
        timestamp: "2026-07-02T00:00:00.000Z",
        type: "assistant",
      },
    ];

    const [entry] = transformClaudeCodeTranscript(entries);

    expect(entry.role).toBe("tool_use");
    expect(entry.cache_read_tokens).toBe(300);
    expect(entry.cache_creation_tokens).toBe(15);
  });

  it("propagates cache fields onto the first block only when array content is [tool_use, text] — no double-counting", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        message: {
          content: [
            { input: { file_path: "/foo.ts" }, name: "Read", type: "tool_use" },
            { text: "Let me check.", type: "text" },
          ],
          role: "assistant",
          usage: { cache_creation_input_tokens: 7, cache_read_input_tokens: 400, output_tokens: 8 },
        },
        timestamp: "2026-07-02T00:00:00.000Z",
        type: "assistant",
      },
    ];

    const [firstEntry, secondEntry] = transformClaudeCodeTranscript(entries);

    expect(firstEntry.role).toBe("tool_use");
    expect(firstEntry.cache_read_tokens).toBe(400);
    expect(firstEntry.cache_creation_tokens).toBe(7);

    expect(secondEntry.role).toBe("assistant");
    expect(secondEntry.cache_read_tokens).toBeUndefined();
    expect(secondEntry.cache_creation_tokens).toBeUndefined();
  });

  it("does not attach cache fields to user entries", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        message: { content: "Please implement the feature.", role: "user" },
        timestamp: "2026-07-02T00:00:00.000Z",
        type: "user",
      },
    ];

    const [entry] = transformClaudeCodeTranscript(entries);

    expect(entry.cache_read_tokens).toBeUndefined();
    expect(entry.cache_creation_tokens).toBeUndefined();
  });

  it("existing transcript entries with no cache fields still transform without them (back-compat)", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        message: { content: "Done.", role: "assistant", usage: { output_tokens: 12 } },
        timestamp: "2026-07-02T00:00:00.000Z",
        type: "assistant",
      },
    ];

    const [entry] = transformClaudeCodeTranscript(entries);

    expect(entry.cache_read_tokens).toBeUndefined();
    expect(entry.cache_creation_tokens).toBeUndefined();
    expect(entry.tokens).toBe(12);
  });
});

describe("aggregateCacheUsage (dc-02)", () => {
  it("sums cache_read/creation/input tokens across assistant turns and derives the hit ratio", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        message: {
          content: "First turn.",
          role: "assistant",
          usage: {
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 100,
            input_tokens: 30,
          },
        },
        timestamp: "2026-07-02T00:00:00.000Z",
        type: "assistant",
      },
      {
        message: {
          content: "Second turn.",
          role: "assistant",
          usage: { cache_read_input_tokens: 50 },
        },
        timestamp: "2026-07-02T00:00:01.000Z",
        type: "assistant",
      },
    ];

    const result = aggregateCacheUsage(entries);

    expect(result.cache_read_tokens).toBe(150);
    expect(result.cache_creation_tokens).toBe(20);
    expect(result.input_tokens).toBe(30);
    // ratio = read / (read + creation + input) = 150 / (150 + 20 + 30) = 0.75
    expect(result.cache_hit_ratio).toBeCloseTo(0.75, 10);
  });

  it("ignores non-assistant (user) turns when aggregating", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        message: {
          content: "user turn with usage (should not happen, but must not count)",
          role: "user",
          usage: { cache_read_input_tokens: 999, input_tokens: 999 },
        },
        timestamp: "2026-07-02T00:00:00.000Z",
        type: "user",
      },
      {
        message: {
          content: "assistant turn",
          role: "assistant",
          usage: { cache_read_input_tokens: 10, input_tokens: 5 },
        },
        timestamp: "2026-07-02T00:00:01.000Z",
        type: "assistant",
      },
    ];

    const result = aggregateCacheUsage(entries);

    expect(result.cache_read_tokens).toBe(10);
    expect(result.input_tokens).toBe(5);
  });

  it("omits cache_hit_ratio (not NaN, not 0) when the denominator is zero", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        message: { content: "No usage at all.", role: "assistant" },
        timestamp: "2026-07-02T00:00:00.000Z",
        type: "assistant",
      },
    ];

    const result = aggregateCacheUsage(entries);

    expect(result.cache_read_tokens).toBe(0);
    expect(result.cache_creation_tokens).toBe(0);
    expect(result.input_tokens).toBe(0);
    expect(result.cache_hit_ratio).toBeUndefined();
    expect("cache_hit_ratio" in result).toBe(false);
  });

  it("skips malformed raw entries rather than throwing", () => {
    const entries = [
      { garbage: true },
      {
        message: {
          content: "valid turn",
          role: "assistant",
          usage: { cache_read_input_tokens: 7, input_tokens: 3 },
        },
        timestamp: "2026-07-02T00:00:00.000Z",
        type: "assistant",
      },
    ] as unknown as ClaudeCodeEntry[];

    expect(() => aggregateCacheUsage(entries)).not.toThrow();
    const result = aggregateCacheUsage(entries);
    expect(result.cache_read_tokens).toBe(7);
    expect(result.input_tokens).toBe(3);
  });

  it("returns empty-safe totals for an empty entries array", () => {
    const result = aggregateCacheUsage([]);

    expect(result).toEqual({ cache_creation_tokens: 0, cache_read_tokens: 0, input_tokens: 0 });
  });
});
