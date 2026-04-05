import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeEffects } from "../orchestration/effects.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { StateDefinition } from "../orchestration/flow-schema.ts";
import { DriftStore } from "../platform/storage/drift/store.ts";

const SAMPLE_REVIEW = `---
verdict: "WARNING"
agent: canon-reviewer
timestamp: "2026-03-23T10:00:00Z"
files-reviewed: 3
principles-checked: 5
---

## Canon Review — Verdict: WARNING

### Principle Compliance

#### Violations
<!-- Ordered by impact score -->
| Principle | Severity | File | Description | Fix |
|-----------|----------|------|-------------|-----|
| thin-handlers | strong-opinion | \`src/api/orders.ts:42\` | Business logic in handler | Extract to service |
| validate-at-boundaries | rule | \`src/api/orders.ts:15\` | Raw input used without validation | Add zod schema |

#### Honored
<!-- Brief notes on principles the code follows well. -->
- **naming-reveals-intent**: Clear function and variable names throughout
- **errors-are-values**: Proper Result type usage in service layer

#### Score
| Layer | Rules | Opinions | Conventions |
|-------|-------|----------|-------------|
| api | 1/2 | 2/3 | 1/1 |
| service | 2/2 | 1/1 | 0/0 |

### Code Quality (Advisory)

#### Suggestions
- **Readability**: Consider extracting the order validation into a separate function
`;

// persist_review — structured .meta.json path and legacy fallback

describe("persistReview via executeEffects — structured .meta.json path", () => {
  let tmpDir: string;
  let workspace: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-effects-meta-test-"));
    workspace = join(tmpDir, "workspace");
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(workspace, "reviews"), { recursive: true });
    await mkdir(join(workspace, "plans", "test-task"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("reads structured data from .meta.json when it exists", async () => {
    const meta = {
      _type: "review",
      _version: 1,
      files: ["src/auth.ts"],
      honored: ["thin-handlers"],
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 2, total: 3 },
        rules: { passed: 1, total: 2 },
      },
      verdict: "BLOCKING",
      verdict_original: "blocked",
      violations: [
        { file_path: "src/auth.ts", principle_id: "secrets-never-in-code", severity: "rule" },
      ],
    };
    await writeFile(join(workspace, "reviews", "REVIEW.meta.json"), JSON.stringify(meta));

    const stateDef: StateDefinition = {
      effects: [{ artifact: "REVIEW.md", type: "persist_review" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir: tmpDir,
      workspace,
    });

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("persist_review");
    expect(results[0].recorded).toBe(1);
    expect(results[0].errors).toHaveLength(0);

    const entries = await new DriftStore(tmpDir).getReviews();
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe("BLOCKING");
    expect(entries[0].violations).toHaveLength(1);
    expect(entries[0].violations[0].principle_id).toBe("secrets-never-in-code");
    expect(entries[0].honored).toEqual(["thin-handlers"]);
  });

  it("verdict from .meta.json is stored correctly in DriftStore", async () => {
    const meta = {
      _type: "review",
      _version: 1,
      files: [],
      honored: ["errors-are-values"],
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 1, total: 1 },
        rules: { passed: 2, total: 2 },
      },
      verdict: "WARNING",
      verdict_original: "approved_with_concerns",
      violations: [],
    };
    await writeFile(join(workspace, "reviews", "REVIEW.meta.json"), JSON.stringify(meta));

    const stateDef: StateDefinition = {
      effects: [{ artifact: "REVIEW.md", type: "persist_review" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir: tmpDir,
      workspace,
    });

    expect(results[0].recorded).toBe(1);
    const entries = await new DriftStore(tmpDir).getReviews();
    expect(entries[0].verdict).toBe("WARNING");
    expect(entries[0].honored).toEqual(["errors-are-values"]);
  });

  it("falls back to legacy REVIEW.md parsing when .meta.json is absent", async () => {
    const reviewPath = join(workspace, "reviews", "REVIEW.md");
    await writeFile(reviewPath, SAMPLE_REVIEW);

    const stateDef: StateDefinition = {
      effects: [{ artifact: "REVIEW.md", type: "persist_review" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir: tmpDir,
      workspace,
    });

    expect(results[0].recorded).toBe(1);
    expect(results[0].errors).toHaveLength(0);

    const entries = await new DriftStore(tmpDir).getReviews();
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe("WARNING");
    expect(entries[0].violations).toHaveLength(2);
    expect(entries[0].honored).toEqual(["naming-reveals-intent", "errors-are-values"]);
  });

  it("falls back to legacy parse when .meta.json has wrong _type", async () => {
    // .meta.json exists but _type is wrong — should fall through to legacy REVIEW.md parse
    const badMeta = { _type: "summary", _version: 1, verdict: "BLOCKING" };
    await writeFile(join(workspace, "reviews", "REVIEW.meta.json"), JSON.stringify(badMeta));
    // Provide a valid REVIEW.md for the fallback
    await writeFile(join(workspace, "reviews", "REVIEW.md"), SAMPLE_REVIEW);

    const stateDef: StateDefinition = {
      effects: [{ artifact: "REVIEW.md", type: "persist_review" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir: tmpDir,
      workspace,
    });

    expect(results[0].recorded).toBe(1);
    // Should have fallen back to REVIEW.md which has verdict WARNING
    const entries = await new DriftStore(tmpDir).getReviews();
    expect(entries[0].verdict).toBe("WARNING");
  });

  it("falls back to legacy parse when .meta.json has wrong _version", async () => {
    // .meta.json exists but _version is wrong — should fall through to legacy REVIEW.md parse
    const badMeta = { _type: "review", _version: 2, verdict: "CLEAN" };
    await writeFile(join(workspace, "reviews", "REVIEW.meta.json"), JSON.stringify(badMeta));
    await writeFile(join(workspace, "reviews", "REVIEW.md"), SAMPLE_REVIEW);

    const stateDef: StateDefinition = {
      effects: [{ artifact: "REVIEW.md", type: "persist_review" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir: tmpDir,
      workspace,
    });

    expect(results[0].recorded).toBe(1);
    const entries = await new DriftStore(tmpDir).getReviews();
    expect(entries[0].verdict).toBe("WARNING"); // from legacy parse of REVIEW.md
  });

  it("returns error when neither .meta.json nor .md artifact is found", async () => {
    const stateDef: StateDefinition = {
      effects: [{ artifact: "REVIEW.md", type: "persist_review" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir: tmpDir,
      workspace,
    });

    expect(results[0].recorded).toBe(0);
    expect(results[0].errors.length).toBeGreaterThan(0);
  });
});

describe("executeEffects", () => {
  let tmpDir: string;
  let workspace: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-effects-test-"));
    workspace = join(tmpDir, "workspace");
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(workspace, "reviews"), { recursive: true });
    await mkdir(join(workspace, "plans", "test-task"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("persist_review writes to reviews.jsonl", async () => {
    const reviewPath = join(workspace, "plans", "test-task", "REVIEW.md");
    await writeFile(reviewPath, SAMPLE_REVIEW);

    const stateDef: StateDefinition = {
      effects: [{ artifact: "REVIEW.md", type: "persist_review" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: ["plans/test-task/REVIEW.md"],
      projectDir: tmpDir,
      workspace,
    });

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("persist_review");
    expect(results[0].recorded).toBe(1);
    expect(results[0].errors).toHaveLength(0);

    // Verify entry was written to drift store
    const entries = await new DriftStore(tmpDir).getReviews();
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe("WARNING");
    expect(entries[0].violations).toHaveLength(2);
    expect(entries[0].honored).toEqual(["naming-reveals-intent", "errors-are-values"]);
  });

  it("returns empty results when no effects defined", async () => {
    const stateDef: StateDefinition = { type: "single" };
    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir: tmpDir,
      workspace,
    });
    expect(results).toHaveLength(0);
  });

  it("handles missing artifact gracefully", async () => {
    const stateDef: StateDefinition = {
      effects: [{ artifact: "NONEXISTENT.md", type: "persist_review" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir: tmpDir,
      workspace,
    });
    expect(results).toHaveLength(1);
    expect(results[0].recorded).toBe(0);
    expect(results[0].errors.length).toBeGreaterThan(0);
  });
});

// check_postconditions effect integration

describe("executeEffects — check_postconditions", () => {
  let tmpDir: string;
  let workspace: string;
  let projectDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-postcond-test-"));
    workspace = join(tmpDir, "workspace");
    projectDir = join(tmpDir, "project");
    await mkdir(workspace, { recursive: true });
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("passes with explicit YAML file_exists postcondition that passes", async () => {
    // Create the file the postcondition checks
    await writeFile(join(projectDir, "output.ts"), "export const x = 1;");

    const stateDef: StateDefinition = {
      effects: [{ type: "check_postconditions" }],
      postconditions: [{ target: "output.ts", type: "file_exists" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir,
      stateName: "review",
      workspace,
    });

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("check_postconditions");
    expect(results[0].recorded).toBe(1);
    expect(results[0].errors).toHaveLength(0);
  });

  it("records failure with explicit YAML file_exists postcondition that fails", async () => {
    // Do NOT create the file — postcondition should fail

    const stateDef: StateDefinition = {
      effects: [{ type: "check_postconditions" }],
      postconditions: [{ target: "missing.ts", type: "file_exists" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir,
      stateName: "review",
      workspace,
    });

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("check_postconditions");
    expect(results[0].recorded).toBe(1);
    expect(results[0].errors).toHaveLength(1);
    expect(results[0].errors[0]).toMatch(/missing\.ts/);
  });

  it("uses discovered_postconditions from board state when no explicit YAML postconditions", async () => {
    // Create the file the discovered postcondition checks
    await writeFile(join(projectDir, "discovered.ts"), "export const x = 1;");

    // Seed ExecutionStore with discovered_postconditions on state "review"
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      base_commit: "abc123",
      branch: "main",
      created: now,
      current_state: "review",
      entry: "review",
      flow: "test-flow",
      flow_name: "test-flow",
      last_updated: now,
      sanitized: "main",
      slug: "test-slug",
      started: now,
      task: "test-task",
      tier: "medium",
    });
    store.upsertState("review", {
      discovered_postconditions: [{ target: "discovered.ts", type: "file_exists" }],
      entries: 1,
      status: "in_progress",
    });

    // stateDef has NO explicit postconditions — only discovered
    const stateDef: StateDefinition = {
      effects: [{ type: "check_postconditions" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir,
      stateName: "review",
      workspace,
    });

    expect(results[0].type).toBe("check_postconditions");
    expect(results[0].recorded).toBe(1);
    expect(results[0].errors).toHaveLength(0);
  });

  it("explicit YAML postconditions take priority over discovered", async () => {
    // Only the explicit file exists, not the discovered one
    await writeFile(join(projectDir, "explicit.ts"), "export const x = 1;");
    // discovered.ts does NOT exist

    // Seed ExecutionStore with discovered_postconditions on state "review"
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      base_commit: "abc123",
      branch: "main",
      created: now,
      current_state: "review",
      entry: "review",
      flow: "test-flow",
      flow_name: "test-flow",
      last_updated: now,
      sanitized: "main",
      slug: "test-slug",
      started: now,
      task: "test-task",
      tier: "medium",
    });
    store.upsertState("review", {
      discovered_postconditions: [{ target: "discovered.ts", type: "file_exists" }],
      entries: 1,
      status: "in_progress",
    });

    const stateDef: StateDefinition = {
      effects: [{ type: "check_postconditions" }],
      postconditions: [{ target: "explicit.ts", type: "file_exists" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, {
      artifacts: [],
      projectDir,
      stateName: "review",
      workspace,
    });

    // Should pass — explicit file exists; discovered is ignored
    expect(results[0].recorded).toBe(1);
    expect(results[0].errors).toHaveLength(0);
  });

  it("returns recorded: 0 when no postconditions declared anywhere", async () => {
    const stateDef: StateDefinition = {
      effects: [{ type: "check_postconditions" }],
      type: "single",
    };

    const results = await executeEffects(stateDef, { artifacts: [], projectDir, workspace });

    expect(results[0].type).toBe("check_postconditions");
    expect(results[0].recorded).toBe(0);
    expect(results[0].errors).toHaveLength(0);
  });

  it("returns recorded: 0 when store has no board data (no crash)", async () => {
    // Empty workspace — ExecutionStore returns null for board
    const stateDef: StateDefinition = {
      effects: [{ type: "check_postconditions" }],
      type: "single",
    };

    // Should not throw — best-effort
    const results = await executeEffects(stateDef, { artifacts: [], projectDir, workspace });

    expect(results[0].type).toBe("check_postconditions");
    expect(results[0].recorded).toBe(0);
    expect(results[0].errors).toHaveLength(0);
  });
});
