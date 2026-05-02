/**
 * Tests for principle-reranker.ts
 *
 * All Anthropic API calls are mocked — no real network calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principle } from "../parser.ts";

// Mock the Anthropic SDK before importing the module under test
vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  const MockAnthropic = vi.fn(() => ({
    messages: { create: mockCreate },
  }));
  // Attach the mock so tests can access it via the mock instance
  (MockAnthropic as unknown as { _mockCreate: typeof mockCreate })._mockCreate = mockCreate;
  return { default: MockAnthropic };
});

import Anthropic from "@anthropic-ai/sdk";
import { rerankPrinciples } from "../principle-reranker.ts";

/** Build a minimal Principle fixture. */
function makePrinciple(id: string, title: string = `${id} title`): Principle {
  return {
    archived: false,
    body: `${title} body text. More details here.`,
    filePath: `principles/${id}.md`,
    id,
    scope: { file_patterns: [], layers: [] },
    severity: "convention",
    tags: [],
    title,
  };
}

/** Build a mocked Anthropic text response. */
function makeTextResponse(text: string) {
  return {
    content: [{ text, type: "text" }],
    id: "msg_test",
    model: "claude-sonnet-4-20250514",
    role: "assistant",
    stop_reason: "end_turn",
    type: "message",
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

const FILE_CONTENT = "export function handler() {}\nexport const MAX = 10;";
const FILE_PATH = "src/api/handler.ts";

describe("rerankPrinciples — short-circuit", () => {
  it("returns all candidates without API call when count <= topN", async () => {
    const candidates = [makePrinciple("a"), makePrinciple("b")];
    const result = await rerankPrinciples(candidates, FILE_CONTENT, FILE_PATH, 5);

    expect(result.selected).toEqual(["a", "b"]);
    expect(result.latency_ms).toBe(0);
    // No Anthropic instance should be created
    expect(vi.mocked(Anthropic)).not.toHaveBeenCalled();
  });

  it("short-circuits when candidates exactly equals topN", async () => {
    const candidates = Array.from({ length: 3 }, (_, i) => makePrinciple(`p${i}`));
    const result = await rerankPrinciples(candidates, FILE_CONTENT, FILE_PATH, 3);

    expect(result.selected).toHaveLength(3);
    expect(result.latency_ms).toBe(0);
  });
});

describe("rerankPrinciples — API call", () => {
  beforeEach(() => {
    vi.mocked(Anthropic).mockClear();
  });

  it("calls Claude and returns parsed IDs from valid JSON response", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => makePrinciple(`p${i}`));

    // Set up: mock will be created when rerankPrinciples instantiates Anthropic
    let capturedMockCreate: ReturnType<typeof vi.fn> | undefined;
    vi.mocked(Anthropic).mockImplementationOnce(function () {
      const mockCreate = vi.fn().mockResolvedValue(makeTextResponse('["p0", "p2", "p4"]'));
      capturedMockCreate = mockCreate;
      return { messages: { create: mockCreate } };
    } as any);

    const result = await rerankPrinciples(candidates, FILE_CONTENT, FILE_PATH, 3);

    expect(result.selected).toEqual(["p0", "p2", "p4"]);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(capturedMockCreate).toHaveBeenCalledOnce();
  });

  it("passes file content and topN in the prompt", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => makePrinciple(`p${i}`));

    let capturedPrompt = "";
    vi.mocked(Anthropic).mockImplementationOnce(function () {
      const mockCreate = vi
        .fn()
        .mockImplementation(async (params: { messages: Array<{ content: string }> }) => {
          capturedPrompt = params.messages[0]?.content ?? "";
          return makeTextResponse('["p0", "p1", "p2"]');
        });
      return { messages: { create: mockCreate } };
    } as any);

    await rerankPrinciples(candidates, FILE_CONTENT, FILE_PATH, 3);

    expect(capturedPrompt).toContain(FILE_CONTENT);
    expect(capturedPrompt).toContain(FILE_PATH);
    expect(capturedPrompt).toContain("3"); // topN
    expect(capturedPrompt).toContain("p0");
  });

  it("filters out IDs not in candidate set", async () => {
    const candidates = [
      makePrinciple("a"),
      makePrinciple("b"),
      makePrinciple("c"),
      makePrinciple("d"),
    ];

    vi.mocked(Anthropic).mockImplementationOnce(function () {
      // Returns some valid + one unknown ID
      const mockCreate = vi.fn().mockResolvedValue(makeTextResponse('["a", "unknown-id", "c"]'));
      return { messages: { create: mockCreate } };
    } as any);

    const result = await rerankPrinciples(candidates, FILE_CONTENT, FILE_PATH, 2);

    expect(result.selected).toEqual(["a", "c"]);
    expect(result.selected).not.toContain("unknown-id");
  });

  it("caps results at topN even if Claude returns more", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => makePrinciple(`p${i}`));

    vi.mocked(Anthropic).mockImplementationOnce(function () {
      // Returns 5 IDs but topN is 2
      const mockCreate = vi
        .fn()
        .mockResolvedValue(makeTextResponse('["p0", "p1", "p2", "p3", "p4"]'));
      return { messages: { create: mockCreate } };
    } as any);

    const result = await rerankPrinciples(candidates, FILE_CONTENT, FILE_PATH, 2);

    expect(result.selected).toHaveLength(2);
  });
});

describe("rerankPrinciples — graceful degradation", () => {
  beforeEach(() => {
    vi.mocked(Anthropic).mockClear();
  });

  it("returns all candidates when API throws", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => makePrinciple(`p${i}`));

    vi.mocked(Anthropic).mockImplementationOnce(function () {
      const mockCreate = vi.fn().mockRejectedValue(new Error("API unavailable"));
      return { messages: { create: mockCreate } };
    } as any);

    const result = await rerankPrinciples(candidates, FILE_CONTENT, FILE_PATH, 3);

    expect(result.selected).toEqual(candidates.map((p) => p.id));
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns all candidates when response is malformed JSON", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => makePrinciple(`p${i}`));

    vi.mocked(Anthropic).mockImplementationOnce(function () {
      const mockCreate = vi.fn().mockResolvedValue(makeTextResponse("not valid json at all"));
      return { messages: { create: mockCreate } };
    } as any);

    const result = await rerankPrinciples(candidates, FILE_CONTENT, FILE_PATH, 3);

    expect(result.selected).toEqual(candidates.map((p) => p.id));
  });

  it("returns all candidates when JSON is not an array", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => makePrinciple(`p${i}`));

    vi.mocked(Anthropic).mockImplementationOnce(function () {
      const mockCreate = vi.fn().mockResolvedValue(makeTextResponse('{"key": "value"}'));
      return { messages: { create: mockCreate } };
    } as any);

    const result = await rerankPrinciples(candidates, FILE_CONTENT, FILE_PATH, 3);

    expect(result.selected).toEqual(candidates.map((p) => p.id));
  });

  it("returns all candidates when response has no text block", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => makePrinciple(`p${i}`));

    vi.mocked(Anthropic).mockImplementationOnce(function () {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [], // empty content array
        id: "msg_test",
        model: "claude-sonnet-4-20250514",
        role: "assistant",
        stop_reason: "end_turn",
        type: "message",
        usage: { input_tokens: 10, output_tokens: 0 },
      });
      return { messages: { create: mockCreate } };
    } as any);

    const result = await rerankPrinciples(candidates, FILE_CONTENT, FILE_PATH, 3);

    expect(result.selected).toEqual(candidates.map((p) => p.id));
  });

  it("returns all candidates when Claude returns empty array of valid IDs", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => makePrinciple(`p${i}`));

    vi.mocked(Anthropic).mockImplementationOnce(function () {
      // Returns only unknown IDs — none in candidate set
      const mockCreate = vi.fn().mockResolvedValue(makeTextResponse('["zzz", "yyy"]'));
      return { messages: { create: mockCreate } };
    } as any);

    const result = await rerankPrinciples(candidates, FILE_CONTENT, FILE_PATH, 3);

    expect(result.selected).toEqual(candidates.map((p) => p.id));
  });
});
