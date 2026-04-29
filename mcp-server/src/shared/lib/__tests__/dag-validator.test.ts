/**
 * dag-validator.test.ts — Tests for validateDag
 *
 * Tests cover:
 * 1. Valid DAG — single task, no dependencies: returns { valid: true, errors: [] }
 * 2. Valid DAG — linear chain: A -> B -> C, all valid
 * 3. Valid DAG — diamond: A -> B, A -> C, B -> D, C -> D
 * 4. Empty DAG: { tasks: [] } returns error
 * 5. Empty task_id: Task with task_id: "" returns error
 * 6. Duplicate task_ids: Two tasks with same id returns error
 * 7. Self-reference: Task A depends on A returns error
 * 8. Unresolved reference: Task A depends on "nonexistent" returns error
 * 9. Simple cycle: A -> B -> A detected
 * 10. Complex cycle: A -> B -> C -> A detected, with D (not in cycle) still valid
 * 11. Multiple errors: DAG with both duplicate ids and self-reference returns both errors
 * 12. parallel_safe false tasks: Valid DAG with parallel_safe: false — validator accepts
 */

import { describe, expect, it } from "vitest";
import { validateDag } from "../dag-validator.ts";
import type { TaskDag } from "../dag-validator.ts";

// ─── Test 1: Valid DAG — single task, no dependencies ───────────────────────

describe("validateDag — single task, no dependencies", () => {
  it("returns valid: true with empty errors", () => {
    const dag: TaskDag = {
      tasks: [
        { task_id: "task-a", depends_on: [], parallel_safe: true, files: [] },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ─── Test 2: Valid DAG — linear chain ───────────────────────────────────────

describe("validateDag — linear chain A -> B -> C", () => {
  it("returns valid: true with empty errors", () => {
    const dag: TaskDag = {
      tasks: [
        { task_id: "A", depends_on: [], parallel_safe: true, files: [] },
        { task_id: "B", depends_on: ["A"], parallel_safe: true, files: [] },
        { task_id: "C", depends_on: ["B"], parallel_safe: true, files: [] },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ─── Test 3: Valid DAG — diamond ─────────────────────────────────────────────

describe("validateDag — diamond A -> B, A -> C, B -> D, C -> D", () => {
  it("returns valid: true with empty errors", () => {
    const dag: TaskDag = {
      tasks: [
        { task_id: "A", depends_on: [], parallel_safe: true, files: [] },
        { task_id: "B", depends_on: ["A"], parallel_safe: true, files: [] },
        { task_id: "C", depends_on: ["A"], parallel_safe: true, files: [] },
        {
          task_id: "D",
          depends_on: ["B", "C"],
          parallel_safe: true,
          files: [],
        },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ─── Test 4: Empty DAG ───────────────────────────────────────────────────────

describe("validateDag — empty DAG", () => {
  it("returns valid: false with empty DAG error", () => {
    const dag: TaskDag = { tasks: [] };
    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("DAG must contain at least one task");
  });
});

// ─── Test 5: Empty task_id ───────────────────────────────────────────────────

describe("validateDag — empty task_id", () => {
  it("returns valid: false with index-based error for empty task_id", () => {
    const dag: TaskDag = {
      tasks: [
        {
          task_id: "ok-task",
          depends_on: [],
          parallel_safe: true,
          files: [],
        },
        { task_id: "", depends_on: [], parallel_safe: true, files: [] },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Task at index 1 has empty task_id");
  });

  it("returns error for whitespace-only task_id", () => {
    const dag: TaskDag = {
      tasks: [
        { task_id: "   ", depends_on: [], parallel_safe: true, files: [] },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Task at index 0 has empty task_id");
  });
});

// ─── Test 6: Duplicate task_ids ──────────────────────────────────────────────

describe("validateDag — duplicate task_ids", () => {
  it("returns valid: false with duplicate id error", () => {
    const dag: TaskDag = {
      tasks: [
        { task_id: "task-a", depends_on: [], parallel_safe: true, files: [] },
        { task_id: "task-a", depends_on: [], parallel_safe: true, files: [] },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Duplicate task_id: task-a");
  });
});

// ─── Test 7: Self-reference ──────────────────────────────────────────────────

describe("validateDag — self-reference", () => {
  it("returns valid: false with self-reference error", () => {
    const dag: TaskDag = {
      tasks: [
        {
          task_id: "task-a",
          depends_on: ["task-a"],
          parallel_safe: true,
          files: [],
        },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Task 'task-a' depends on itself");
  });
});

// ─── Test 8: Unresolved reference ────────────────────────────────────────────

describe("validateDag — unresolved reference", () => {
  it("returns valid: false with unknown dependency error", () => {
    const dag: TaskDag = {
      tasks: [
        {
          task_id: "task-a",
          depends_on: ["nonexistent"],
          parallel_safe: true,
          files: [],
        },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Task 'task-a' depends on unknown task 'nonexistent'",
    );
  });
});

// ─── Test 9: Simple cycle ────────────────────────────────────────────────────

describe("validateDag — simple cycle A -> B -> A", () => {
  it("returns valid: false with cycle error mentioning both tasks", () => {
    const dag: TaskDag = {
      tasks: [
        { task_id: "A", depends_on: ["B"], parallel_safe: true, files: [] },
        { task_id: "B", depends_on: ["A"], parallel_safe: true, files: [] },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    const cycleError = result.errors.find((e) =>
      e.startsWith("Cycle detected involving tasks:"),
    );
    expect(cycleError).toBeDefined();
    expect(cycleError).toContain("A");
    expect(cycleError).toContain("B");
  });
});

// ─── Test 10: Complex cycle ──────────────────────────────────────────────────

describe("validateDag — complex cycle A -> B -> C -> A with D not in cycle", () => {
  it("returns valid: false; cycle error includes A, B, C; D is not mentioned in cycle error", () => {
    const dag: TaskDag = {
      tasks: [
        { task_id: "A", depends_on: ["C"], parallel_safe: true, files: [] },
        { task_id: "B", depends_on: ["A"], parallel_safe: true, files: [] },
        { task_id: "C", depends_on: ["B"], parallel_safe: true, files: [] },
        { task_id: "D", depends_on: [], parallel_safe: true, files: [] },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    const cycleError = result.errors.find((e) =>
      e.startsWith("Cycle detected involving tasks:"),
    );
    expect(cycleError).toBeDefined();
    expect(cycleError).toContain("A");
    expect(cycleError).toContain("B");
    expect(cycleError).toContain("C");
    // D is NOT in the cycle — should not appear in the cycle error message
    expect(cycleError).not.toContain("D");
  });

  it("reports exactly one cycle error", () => {
    const dag: TaskDag = {
      tasks: [
        { task_id: "A", depends_on: ["C"], parallel_safe: true, files: [] },
        { task_id: "B", depends_on: ["A"], parallel_safe: true, files: [] },
        { task_id: "C", depends_on: ["B"], parallel_safe: true, files: [] },
        { task_id: "D", depends_on: [], parallel_safe: true, files: [] },
      ],
    };
    const result = validateDag(dag);
    const cycleErrors = result.errors.filter((e) =>
      e.startsWith("Cycle detected involving tasks:"),
    );
    expect(cycleErrors).toHaveLength(1);
  });
});

// ─── Test 11: Multiple errors ────────────────────────────────────────────────

describe("validateDag — multiple errors (duplicate ids + self-reference)", () => {
  it("returns both duplicate id and self-reference errors", () => {
    const dag: TaskDag = {
      tasks: [
        {
          task_id: "task-a",
          depends_on: ["task-a"],
          parallel_safe: true,
          files: [],
        },
        { task_id: "task-a", depends_on: [], parallel_safe: true, files: [] },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Duplicate task_id: task-a");
    expect(result.errors).toContain("Task 'task-a' depends on itself");
  });
});

// ─── Test 12: parallel_safe: false ──────────────────────────────────────────

describe("validateDag — parallel_safe: false tasks", () => {
  it("accepts tasks with parallel_safe: false without errors", () => {
    const dag: TaskDag = {
      tasks: [
        {
          task_id: "sequential-task",
          depends_on: [],
          parallel_safe: false,
          files: ["src/index.ts"],
        },
        {
          task_id: "another-task",
          depends_on: ["sequential-task"],
          parallel_safe: false,
          files: ["src/utils.ts"],
        },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
