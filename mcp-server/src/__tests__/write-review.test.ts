import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseReviewArtifact } from "../orchestration/effects.ts";
import { VERDICT_MAP, type WriteReviewInput, writeReview } from "../tools/write-review.ts";
import { assertOk } from "../utils/tool-result.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

// Fixtures

const BASE_INPUT: WriteReviewInput = {
  files: ["src/foo.ts", "src/bar.ts"],
  honored: ["errors-are-values", "thin-handlers"],
  score: {
    conventions: { passed: 2, total: 2 },
    opinions: { passed: 3, total: 4 },
    rules: { passed: 5, total: 5 },
  },
  slug: "my-epic",
  verdict: "approved",
  violations: [],
  workspace: "", // overwritten per-test
};

function makeInput(overrides: Partial<WriteReviewInput> = {}): WriteReviewInput {
  return { ...BASE_INPUT, workspace: tmpDir, ...overrides };
}

// Happy path — files created in reviews/ directory

describe("writeReview — file output", () => {
  it("writes REVIEW.md and REVIEW.meta.json to reviews/ directory", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput());

    assertOk(result);
    expect(result.path.replaceAll("\\", "/")).toContain("reviews/REVIEW.md");
    expect(result.meta_path.replaceAll("\\", "/")).toContain("reviews/REVIEW.meta.json");

    // Verify files exist
    const md = await readFile(result.path, "utf-8");
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));

    expect(md.length).toBeGreaterThan(0);
    expect(meta._type).toBe("review");
  });

  it("creates the reviews directory if it does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput());

    assertOk(result);
    // No throw = directory was created successfully
    const content = await readFile(result.path, "utf-8");
    expect(content).toBeTruthy();
  });
});

// Verdict mapping

describe("writeReview — verdict mapping", () => {
  it("maps approved -> CLEAN", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ verdict: "approved" }));

    assertOk(result);
    expect(result.verdict).toBe("CLEAN");
  });

  it("maps approved_with_concerns -> WARNING", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ verdict: "approved_with_concerns" }));

    assertOk(result);
    expect(result.verdict).toBe("WARNING");
  });

  it("maps changes_required -> WARNING", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ verdict: "changes_required" }));

    assertOk(result);
    expect(result.verdict).toBe("WARNING");
  });

  it("maps blocked -> BLOCKING", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ verdict: "blocked" }));

    assertOk(result);
    expect(result.verdict).toBe("BLOCKING");
  });

  it("VERDICT_MAP covers all four ADR-010 verdicts", () => {
    expect(VERDICT_MAP.approved).toBe("CLEAN");
    expect(VERDICT_MAP.approved_with_concerns).toBe("WARNING");
    expect(VERDICT_MAP.changes_required).toBe("WARNING");
    expect(VERDICT_MAP.blocked).toBe("BLOCKING");
  });
});

// Markdown content

describe("writeReview — markdown content", () => {
  it("includes YAML frontmatter with mapped verdict", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ verdict: "blocked" }));

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("verdict: BLOCKING");
  });

  it("includes Canon Review heading with mapped verdict", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ verdict: "approved" }));

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).toMatch(/## Canon Review\s*[—-]\s*Verdict:\s*CLEAN/i);
  });

  it("includes violations table section", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(
      makeInput({
        verdict: "blocked",
        violations: [
          {
            description: "throws instead of returning",
            file_path: "src/foo.ts",
            principle_id: "errors-are-values",
            severity: "rule",
          },
        ],
      }),
    );

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).toContain("#### Violations");
    expect(md).toContain("errors-are-values");
    expect(md).toContain("rule");
    expect(md).toContain("src/foo.ts");
  });

  it("includes honored list section", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(
      makeInput({ honored: ["thin-handlers", "validate-at-boundaries"] }),
    );

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).toContain("#### Honored");
    expect(md).toContain("**thin-handlers**");
    expect(md).toContain("**validate-at-boundaries**");
  });

  it("includes score table section", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(
      makeInput({
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 2, total: 3 },
          rules: { passed: 4, total: 5 },
        },
      }),
    );

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).toContain("#### Score");
    expect(md).toContain("4 / 5");
    expect(md).toContain("2 / 3");
    expect(md).toContain("1 / 1");
  });
});

// Meta JSON

describe("writeReview — meta JSON", () => {
  it("meta has _type: review and _version: 1", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput());

    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta._type).toBe("review");
    expect(meta._version).toBe(1);
  });

  it("meta stores both verdict_original and mapped verdict", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ verdict: "approved_with_concerns" }));

    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta.verdict_original).toBe("approved_with_concerns");
    expect(meta.verdict).toBe("WARNING");
  });

  it("meta includes violations, honored, score, files", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const violations = [
      { file_path: "src/index.ts", principle_id: "thin-handlers", severity: "strong-opinion" },
    ];
    const result = await writeReview(
      makeInput({
        files: ["src/index.ts"],
        honored: ["errors-are-values"],
        verdict: "changes_required",
        violations,
      }),
    );

    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta.violations).toEqual(violations);
    expect(meta.honored).toEqual(["errors-are-values"]);
    expect(meta.files).toEqual(["src/index.ts"]);
    expect(meta.score).toMatchObject({
      rules: { passed: expect.any(Number), total: expect.any(Number) },
    });
  });
});

// Return value

describe("writeReview — return value", () => {
  it("returns violation_count matching violations array length", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(
      makeInput({
        violations: [
          { principle_id: "p1", severity: "rule" },
          { principle_id: "p2", severity: "convention" },
        ],
      }),
    );

    assertOk(result);
    expect(result.violation_count).toBe(2);
  });

  it("returns violation_count 0 when no violations", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ violations: [] }));

    assertOk(result);
    expect(result.violation_count).toBe(0);
  });
});

describe("writeReview — validation errors", () => {
  it("returns INVALID_INPUT for invalid slug (spaces)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ slug: "has spaces" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("slug");
    }
  });

  it("returns INVALID_INPUT for invalid slug (special chars)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ slug: "my/epic" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for path traversal in slug", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ slug: "../etc" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});

// Backward compat: parseReviewArtifact can parse generated markdown

describe("writeReview — backward compat with parseReviewArtifact", () => {
  it("generated REVIEW.md is parseable by parseReviewArtifact (approved -> CLEAN)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ verdict: "approved" }));

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    const parsed = parseReviewArtifact(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.verdict).toBe("CLEAN");
  });

  it("generated REVIEW.md is parseable by parseReviewArtifact (blocked -> BLOCKING)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(
      makeInput({
        verdict: "blocked",
        violations: [
          {
            file_path: "src/bad.ts",
            principle_id: "errors-are-values",
            severity: "rule",
          },
        ],
      }),
    );

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    const parsed = parseReviewArtifact(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.verdict).toBe("BLOCKING");
    expect(parsed!.violations.length).toBe(1);
    expect(parsed!.violations[0].principle_id).toBe("errors-are-values");
  });

  it("parseReviewArtifact extracts honored list from generated markdown", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(
      makeInput({ honored: ["thin-handlers", "errors-are-values"] }),
    );

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    const parsed = parseReviewArtifact(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.honored).toContain("thin-handlers");
    expect(parsed!.honored).toContain("errors-are-values");
  });

  it("parseReviewArtifact extracts score from generated markdown", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(
      makeInput({
        score: {
          conventions: { passed: 1, total: 2 },
          opinions: { passed: 2, total: 3 },
          rules: { passed: 3, total: 4 },
        },
      }),
    );

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    const parsed = parseReviewArtifact(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.score.rules.passed).toBe(3);
    expect(parsed!.score.rules.total).toBe(4);
    expect(parsed!.score.opinions.passed).toBe(2);
    expect(parsed!.score.conventions.total).toBe(2);
  });

  it("parseReviewArtifact handles empty violations (CLEAN review)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const result = await writeReview(makeInput({ verdict: "approved", violations: [] }));

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    const parsed = parseReviewArtifact(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.violations).toEqual([]);
    expect(parsed!.verdict).toBe("CLEAN");
  });

  it("generates markdown parseable for all four verdict values", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-test-"));

    const verdicts: WriteReviewInput["verdict"][] = [
      "approved",
      "approved_with_concerns",
      "changes_required",
      "blocked",
    ];
    const expectedMapped = ["CLEAN", "WARNING", "WARNING", "BLOCKING"] as const;

    for (let i = 0; i < verdicts.length; i++) {
      const subDir = await mkdtemp(join(tmpdir(), "write-review-test-v-"));
      const result = await writeReview({ ...makeInput(), verdict: verdicts[i], workspace: subDir });
      assertOk(result);
      const md = await readFile(result.path, "utf-8");
      const parsed = parseReviewArtifact(md);
      expect(parsed).not.toBeNull();
      expect(parsed!.verdict).toBe(expectedMapped[i]);
      await rm(subDir, { force: true, recursive: true });
    }
  });
});
