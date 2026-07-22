/**
 * write-review-t2-trigger.test.ts — app-handler tests for the T2 recorder
 * side-effect wired into handleWriteReviewCall (ADR-0065).
 *
 * The mandatory AC-5 proof lives here at the handler boundary: a recorder
 * that fails to dispatch must produce a ToolResult identical to the
 * success case in every field EXCEPT t2_recorder_triggered — the one field
 * that exists precisely to report that difference. No exception may
 * escape the handler either way.
 *
 * All dependencies of register-artifacts.ts are mocked so this test never
 * touches a real drift DB, execution store, or subprocess — mirrors the
 * mocking style of recall-handler.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/server-state.ts", () => ({
  gatedWrapHandler: (fn: unknown) => fn,
  resolveScope: vi.fn(),
}));

vi.mock("@platform/storage/drift/drift-db-cache.ts", () => ({
  getDriftDb: vi.fn(() => undefined),
}));

vi.mock("@features/orchestration/tools/write-review.ts", () => ({
  writeReview: vi.fn(),
}));

vi.mock("@domains/workspaces/execution-store-cache.ts", () => ({
  getExecutionStore: vi.fn(),
}));

vi.mock("@features/orchestration/services/t2-recorder-trigger.ts", () => ({
  triggerT2Recorder: vi.fn(),
}));

vi.mock("@features/diagnostics/services/prediction-tracker.ts", () => ({
  reconcilePredictions: vi.fn(),
}));

import { resolveScope } from "@app/server-state.ts";
// Import after mocks are set up.
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { triggerT2Recorder } from "@features/orchestration/services/t2-recorder-trigger.ts";
import { writeReview } from "@features/orchestration/tools/write-review.ts";
import { handleWriteReviewCall } from "../register-artifacts.ts";

const OK_RESULT = {
  meta_path: "/ws/reviews/REVIEW.meta.json",
  ok: true as const,
  path: "/ws/reviews/REVIEW.md",
  verdict: "CLEAN" as const,
  violation_count: 0,
};

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    files: [],
    honored: [],
    score: {
      conventions: { passed: 1, total: 1 },
      opinions: { passed: 1, total: 1 },
      rules: { passed: 1, total: 1 },
    },
    slug: "my-slug",
    verdict: "approved" as const,
    violations: [],
    workspace: "/ws",
    ...overrides,
  };
}

const fakeExtra = {} as never;

describe("handleWriteReviewCall — T2 recorder trigger (ADR-0065)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveScope).mockReturnValue("/main/checkout");
    vi.mocked(writeReview).mockResolvedValue(OK_RESULT);
    vi.mocked(getExecutionStore).mockReturnValue({
      getBoard: () => ({ base_commit: "deadbeef" }),
    } as never);
  });

  it("triggers the recorder on a canonical (step_id-absent) write and sets t2_recorder_triggered:true on success", async () => {
    vi.mocked(triggerT2Recorder).mockReturnValue(true);

    const result = await handleWriteReviewCall(baseInput(), fakeExtra);

    expect(triggerT2Recorder).toHaveBeenCalledTimes(1);
    expect(triggerT2Recorder).toHaveBeenCalledWith({
      base: "deadbeef",
      projectDir: "/main/checkout",
      slug: "my-slug",
      worktree: "/ws/worktree",
    });
    expect(result).toEqual({ ...OK_RESULT, t2_recorder_triggered: true });
  });

  it("does NOT trigger the recorder on a step-scoped (juror) write; t2_recorder_triggered is falsy", async () => {
    const result = await handleWriteReviewCall(baseInput({ step_id: "lens-a" }), fakeExtra);

    expect(triggerT2Recorder).not.toHaveBeenCalled();
    expect((result as { t2_recorder_triggered?: boolean }).t2_recorder_triggered).toBeFalsy();
    // Every other field is untouched.
    expect(result).toMatchObject(OK_RESULT);
  });

  it("AC-5: a failing recorder dispatch never changes the ToolResult shape or throws — only t2_recorder_triggered differs", async () => {
    vi.mocked(triggerT2Recorder).mockReturnValue(false);

    // A rejection here (the failure this test guards against) fails the
    // test naturally — no throw/reject wrapper needed.
    const result = await handleWriteReviewCall(baseInput(), fakeExtra);

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      const { t2_recorder_triggered, ...rest } = result;
      expect(rest).toEqual(OK_RESULT);
      expect(t2_recorder_triggered).toBe(false);
    }
  });

  it("skips the trigger (and never throws) when the resolved scope is falsy", async () => {
    vi.mocked(resolveScope).mockReturnValue("");

    const result = await handleWriteReviewCall(baseInput(), fakeExtra);

    expect(triggerT2Recorder).not.toHaveBeenCalled();
    expect(getExecutionStore).not.toHaveBeenCalled();
    expect((result as { t2_recorder_triggered?: boolean }).t2_recorder_triggered).toBe(false);
  });

  it("skips the trigger when base_commit is unresolvable on the board", async () => {
    vi.mocked(getExecutionStore).mockReturnValue({ getBoard: () => ({}) } as never);

    const result = await handleWriteReviewCall(baseInput(), fakeExtra);

    expect(triggerT2Recorder).not.toHaveBeenCalled();
    expect((result as { t2_recorder_triggered?: boolean }).t2_recorder_triggered).toBe(false);
  });

  it("degrades to false (never throws) when getExecutionStore itself throws", async () => {
    vi.mocked(getExecutionStore).mockImplementation(() => {
      throw new Error("bad workspace path");
    });

    // A rejection here (the failure this test guards against) fails the
    // test naturally — no throw/reject wrapper needed.
    const result = await handleWriteReviewCall(baseInput(), fakeExtra);

    expect((result as { t2_recorder_triggered?: boolean }).t2_recorder_triggered).toBe(false);
  });

  it("does not call the trigger when writeReview itself fails", async () => {
    vi.mocked(writeReview).mockResolvedValue({
      error_code: "INVALID_INPUT",
      message: "bad input",
      ok: false as const,
      recoverable: true,
    });

    const result = await handleWriteReviewCall(baseInput(), fakeExtra);

    expect(triggerT2Recorder).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});
