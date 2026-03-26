import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { reportInputSchema } from "../schema.ts";
import { report } from "../tools/report.ts";

// --- Schema validation ---

describe("reportInputSchema", () => {
  it("parses a review with optional file_path and impact_score on violations", () => {
    const input = {
      type: "review" as const,
      files: ["src/a.ts"],
      violations: [{ principle_id: "p1", severity: "rule", file_path: "src/a.ts", impact_score: 5.2 }],
      honored: [],
      score: {
        rules: { passed: 0, total: 1 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
    };
    const parsed = reportInputSchema.parse(input);
    if (parsed.type === "review") {
      expect(parsed.violations[0].file_path).toBe("src/a.ts");
      expect(parsed.violations[0].impact_score).toBe(5.2);
    }
  });

  it("rejects input with missing required fields", () => {
    expect(() =>
      reportInputSchema.parse({ type: "decision", principle_id: "p1" })
    ).toThrow();
  });

  it("rejects input with invalid type discriminant", () => {
    expect(() =>
      reportInputSchema.parse({ type: "unknown", foo: "bar" })
    ).toThrow();
  });

  it("rejects pattern with empty file_paths array", () => {
    expect(() =>
      reportInputSchema.parse({
        type: "pattern",
        pattern: "something",
        file_paths: [],
      })
    ).toThrow();
  });
});

// --- report() integration with real temp directory ---

describe("report()", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function readJsonl<T>(filePath: string): Promise<T[]> {
    const content = await readFile(filePath, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as T);
  }

  it("records a decision and writes to decisions.jsonl", async () => {
    const result = await report(
      {
        type: "decision",
        principle_id: "p1",
        file_path: "src/foo.ts",
        justification: "Legacy constraint",
      },
      tmpDir
    );

    expect(result.recorded).toBe(true);
    expect(result.id).toMatch(/^dec_\d{8}_[0-9a-f]{16}$/);

    const entries = await readJsonl(join(tmpDir, ".canon", "decisions.jsonl"));
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).principle_id).toBe("p1");
    expect((entries[0] as any).decision_id).toBe(result.id);
  });

  it("records a pattern and writes to patterns.jsonl", async () => {
    const result = await report(
      {
        type: "pattern",
        pattern: "Early returns on error",
        file_paths: ["src/a.ts", "src/b.ts"],
      },
      tmpDir
    );

    expect(result.recorded).toBe(true);
    expect(result.id).toMatch(/^pat_\d{8}_[0-9a-f]{16}$/);

    const entries = await readJsonl(join(tmpDir, ".canon", "patterns.jsonl"));
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).pattern).toBe("Early returns on error");
    expect((entries[0] as any).context).toBe(""); // default when omitted
  });

  it("records a review with derived BLOCKING verdict (rule violation)", async () => {
    const result = await report(
      {
        type: "review",
        files: ["src/a.ts"],
        violations: [{ principle_id: "p1", severity: "rule" }],
        honored: ["p2"],
        score: {
          rules: { passed: 0, total: 1 },
          opinions: { passed: 1, total: 1 },
          conventions: { passed: 0, total: 0 },
        },
      },
      tmpDir
    );

    expect(result.recorded).toBe(true);
    expect(result.id).toMatch(/^rev_/);

    const entries = await readJsonl<any>(join(tmpDir, ".canon", "reviews.jsonl"));
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe("BLOCKING");
  });

  it("derives WARNING verdict for strong-opinion violation", async () => {
    const result = await report(
      {
        type: "review",
        files: ["src/a.ts"],
        violations: [{ principle_id: "p1", severity: "strong-opinion" }],
        honored: ["p2"],
        score: {
          rules: { passed: 1, total: 1 },
          opinions: { passed: 0, total: 1 },
          conventions: { passed: 0, total: 0 },
        },
      },
      tmpDir
    );

    const entries = await readJsonl<any>(join(tmpDir, ".canon", "reviews.jsonl"));
    expect(entries[0].verdict).toBe("WARNING");
  });

  it("derives CLEAN verdict when no violations", async () => {
    await report(
      {
        type: "review",
        files: ["src/a.ts"],
        violations: [],
        honored: ["p1", "p2"],
        score: {
          rules: { passed: 2, total: 2 },
          opinions: { passed: 1, total: 1 },
          conventions: { passed: 0, total: 0 },
        },
      },
      tmpDir
    );

    const entries = await readJsonl<any>(join(tmpDir, ".canon", "reviews.jsonl"));
    expect(entries[0].verdict).toBe("CLEAN");
  });

  it("uses explicit verdict when provided instead of deriving", async () => {
    await report(
      {
        type: "review",
        files: ["src/a.ts"],
        violations: [{ principle_id: "p1", severity: "rule" }],
        honored: [],
        score: {
          rules: { passed: 0, total: 1 },
          opinions: { passed: 0, total: 0 },
          conventions: { passed: 0, total: 0 },
        },
        verdict: "WARNING", // explicit override — would be BLOCKING if derived
      },
      tmpDir
    );

    const entries = await readJsonl<any>(join(tmpDir, ".canon", "reviews.jsonl"));
    expect(entries[0].verdict).toBe("WARNING");
  });
});
