import { describe, it, expect } from "vitest";
import { categorizeFailures } from "../tools/categorize-failures.ts";
import { isToolError } from "../utils/tool-result.ts";
import type { CategorizeFailuresInput } from "../tools/categorize-failures.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<CategorizeFailuresInput> = {}): CategorizeFailuresInput {
  return {
    workspace: "/tmp/ws",
    failures: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("categorize_failures — edge cases", () => {
  it("returns INVALID_INPUT error for empty failures array", async () => {
    const result = await categorizeFailures(makeInput({ failures: [] }));
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("single failure → 1 category, confidence 0.95, needs_refinement false", async () => {
    const result = await categorizeFailures(
      makeInput({
        failures: [
          { file: "src/auth.test.ts", error_message: "Cannot read property 'token' of undefined" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].confidence).toBe(0.95);
    expect(result.needs_refinement).toBe(false);
    expect(result.uncategorized).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Exact error match (confidence 0.95)
// ---------------------------------------------------------------------------

describe("categorize_failures — exact error match", () => {
  it("5 failures with 2 distinct error messages → 2 groups, both confidence 0.95, needs_refinement false", async () => {
    const result = await categorizeFailures(
      makeInput({
        failures: [
          { file: "src/a.test.ts", error_message: "TypeError: Cannot read property 'x'" },
          { file: "src/b.test.ts", error_message: "TypeError: Cannot read property 'x'" },
          { file: "src/c.test.ts", error_message: "TypeError: Cannot read property 'x'" },
          { file: "src/d.test.ts", error_message: "ImportError: module 'foo' not found" },
          { file: "src/e.test.ts", error_message: "ImportError: module 'foo' not found" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.categories).toHaveLength(2);
    for (const cat of result.categories) {
      expect(cat.confidence).toBe(0.95);
    }
    expect(result.needs_refinement).toBe(false);
    expect(result.uncategorized).toHaveLength(0);
  });

  it("all high confidence groups → needs_refinement false", async () => {
    const result = await categorizeFailures(
      makeInput({
        failures: [
          { file: "src/a.test.ts", error_message: "same error" },
          { file: "src/b.test.ts", error_message: "same error" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_refinement).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error type grouping (confidence 0.9)
// ---------------------------------------------------------------------------

describe("categorize_failures — error type grouping", () => {
  it("failures grouped by error_type get confidence 0.9, needs_refinement false", async () => {
    const result = await categorizeFailures(
      makeInput({
        failures: [
          {
            file: "src/a.test.ts",
            error_message: "Cannot read property 'x' of undefined",
            error_type: "TypeError",
          },
          {
            file: "src/b.test.ts",
            error_message: "Cannot read property 'y' of null",
            error_type: "TypeError",
          },
          {
            file: "src/c.test.ts",
            error_message: "Cannot read property 'z' of undefined",
            error_type: "TypeError",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All 3 have same error_type — should group together (no exact match since messages differ)
    const typeCat = result.categories.find((c) => c.confidence === 0.9);
    expect(typeCat).toBeDefined();
    expect(typeCat!.files).toHaveLength(3);
    expect(result.needs_refinement).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Same file grouping (confidence 0.85)
// ---------------------------------------------------------------------------

describe("categorize_failures — same file grouping", () => {
  it("3 failures in same test file → 1 group, confidence 0.85, needs_refinement false", async () => {
    const result = await categorizeFailures(
      makeInput({
        failures: [
          {
            file: "src/auth.test.ts",
            test_name: "test A",
            error_message: "expected true to be false",
          },
          {
            file: "src/auth.test.ts",
            test_name: "test B",
            error_message: "expected 1 to equal 2",
          },
          {
            file: "src/auth.test.ts",
            test_name: "test C",
            error_message: "timeout exceeded",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].confidence).toBe(0.85);
    expect(result.categories[0].files).toHaveLength(1);
    expect(result.needs_refinement).toBe(false);
    expect(result.uncategorized).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Directory prefix grouping (confidence 0.7)
// ---------------------------------------------------------------------------

describe("categorize_failures — directory prefix grouping", () => {
  it("failures in same directory, no common error substring → confidence 0.7, needs_refinement true", async () => {
    const result = await categorizeFailures(
      makeInput({
        failures: [
          { file: "src/utils/string.test.ts", error_message: "assertion failed: expected 'foo'" },
          { file: "src/utils/number.test.ts", error_message: "timeout: test exceeded 5000ms" },
          { file: "src/utils/array.test.ts", error_message: "expected [] to deeply equal [1,2,3]" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dirCat = result.categories.find((c) => c.confidence === 0.7);
    expect(dirCat).toBeDefined();
    expect(result.needs_refinement).toBe(true);
  });

  it("directory prefix with common error substring → confidence 0.8, needs_refinement false", async () => {
    const sharedSubstring = "Cannot find module '@internal/shared-utils'";
    const result = await categorizeFailures(
      makeInput({
        failures: [
          {
            file: "src/utils/string.test.ts",
            error_message: `${sharedSubstring} from './string'`,
          },
          {
            file: "src/utils/number.test.ts",
            error_message: `${sharedSubstring} from './number'`,
          },
          {
            file: "src/utils/array.test.ts",
            error_message: `${sharedSubstring} from './array'`,
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boostedCat = result.categories.find((c) => c.confidence === 0.8);
    expect(boostedCat).toBeDefined();
    expect(result.needs_refinement).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mixed signals — priority ordering
// ---------------------------------------------------------------------------

describe("categorize_failures — mixed signals", () => {
  it("failure matching both exact error and error_type gets exact error (0.95) group", async () => {
    const result = await categorizeFailures(
      makeInput({
        failures: [
          // Group 1: exact error match (0.95)
          {
            file: "src/a.test.ts",
            error_message: "Cannot read property 'x' of undefined",
            error_type: "TypeError",
          },
          {
            file: "src/b.test.ts",
            error_message: "Cannot read property 'x' of undefined",
            error_type: "TypeError",
          },
          // Group 2: same file (0.85) — different error messages but same file
          {
            file: "src/auth.test.ts",
            test_name: "test A",
            error_message: "assertion one",
          },
          {
            file: "src/auth.test.ts",
            test_name: "test B",
            error_message: "assertion two",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // First two failures share exact error message — should be in one group with 0.95
    const exactGroup = result.categories.find((c) => c.confidence === 0.95);
    expect(exactGroup).toBeDefined();
    expect(exactGroup!.files).toContain("src/a.test.ts");
    expect(exactGroup!.files).toContain("src/b.test.ts");

    // Last two failures are in same file — should be in same-file group 0.85
    const fileGroup = result.categories.find((c) => c.confidence === 0.85);
    expect(fileGroup).toBeDefined();
    expect(fileGroup!.files).toContain("src/auth.test.ts");
  });
});

// ---------------------------------------------------------------------------
// needs_refinement trigger
// ---------------------------------------------------------------------------

describe("categorize_failures — needs_refinement trigger", () => {
  it("unique failures each become singleton exact-error groups (0.95), needs_refinement false", async () => {
    // Failures in different files, different dirs, different errors, no error_type.
    // Each is unique — they become singleton exact-error groups at 0.95.
    // All groups are above threshold → needs_refinement false.
    const result = await categorizeFailures(
      makeInput({
        failures: [
          { file: "src/alpha/one.test.ts", error_message: "unique error alpha one" },
          { file: "src/beta/two.test.ts", error_message: "unique error beta two" },
          { file: "src/gamma/three.test.ts", error_message: "unique error gamma three" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Each unique failure becomes its own singleton exact-error group
    expect(result.categories).toHaveLength(3);
    for (const cat of result.categories) {
      expect(cat.confidence).toBe(0.95);
    }
    expect(result.uncategorized).toHaveLength(0);
    expect(result.needs_refinement).toBe(false);
  });

  it("directory-prefix group with no common substring triggers needs_refinement (confidence 0.7 < 0.8)", async () => {
    // This also covers needs_refinement: true via low-confidence group
    const result = await categorizeFailures(
      makeInput({
        failures: [
          { file: "src/utils/string.test.ts", error_message: "assertion failed: expected 'foo'" },
          { file: "src/utils/number.test.ts", error_message: "timeout: test exceeded 5000ms" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_refinement).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LLM refinement pass-through
// ---------------------------------------------------------------------------

describe("categorize_failures — LLM refinement pass-through", () => {
  it("refined_categories provided → structured output with confidence 1.0, needs_refinement false", async () => {
    const result = await categorizeFailures(
      makeInput({
        failures: [
          { file: "src/utils/string.test.ts", error_message: "unique error alpha" },
          { file: "src/utils/number.test.ts", error_message: "unique error beta" },
        ],
        refined_categories: [
          {
            category: "missing-dependency",
            description: "Both utils fail due to missing shared dependency",
            files: ["src/utils/string.test.ts", "src/utils/number.test.ts"],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].confidence).toBe(1.0);
    expect(result.categories[0].category).toBe("missing-dependency");
    expect(result.needs_refinement).toBe(false);
  });

  it("refined_categories with invalid file → returns error", async () => {
    const result = await categorizeFailures(
      makeInput({
        failures: [{ file: "src/real.test.ts", error_message: "some error" }],
        refined_categories: [
          {
            category: "bad-category",
            description: "References a file that does not exist in failures",
            files: ["src/does-not-exist.test.ts"],
          },
        ],
      }),
    );
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});
