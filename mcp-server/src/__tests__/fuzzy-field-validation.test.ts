import { describe, it, expect } from "vitest";
import { suggestField, checkUnknownFields } from "../utils/fuzzy-field-validation.ts";

const REPORT_RESULT_KEYS = [
  "workspace",
  "state_id",
  "status_keyword",
  "flow",
  "artifacts",
  "concern_text",
  "error",
  "metrics",
  "progress_line",
];

describe("suggestField", () => {
  it("suggests status_keyword for status (substring match)", () => {
    expect(suggestField("status", REPORT_RESULT_KEYS)).toBe("status_keyword");
  });

  it("suggests state_id for stateId (edit distance)", () => {
    expect(suggestField("stateId", REPORT_RESULT_KEYS)).toBe("state_id");
  });

  it("suggests workspace for workspce (typo)", () => {
    expect(suggestField("workspce", REPORT_RESULT_KEYS)).toBe("workspace");
  });

  it("returns null for completely unrelated field", () => {
    expect(suggestField("banana_phone", REPORT_RESULT_KEYS)).toBeNull();
  });

  it("suggests artifacts for artifact (substring)", () => {
    expect(suggestField("artifact", REPORT_RESULT_KEYS)).toBe("artifacts");
  });
});

describe("checkUnknownFields", () => {
  it("returns empty array for valid input", () => {
    const errors = checkUnknownFields(
      "report_result",
      { workspace: "/tmp", state_id: "review", status_keyword: "clean" },
      REPORT_RESULT_KEYS,
    );
    expect(errors).toEqual([]);
  });

  it("reports unknown field with suggestion", () => {
    const errors = checkUnknownFields(
      "report_result",
      { workspace: "/tmp", state_id: "review", status: "clean" },
      REPORT_RESULT_KEYS,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Unknown field "status"');
    expect(errors[0]).toContain("report_result");
    expect(errors[0]).toContain('did you mean "status_keyword"');
  });

  it("reports unknown field without suggestion when nothing is close", () => {
    const errors = checkUnknownFields(
      "report_result",
      { workspace: "/tmp", completely_unrelated: "foo" },
      REPORT_RESULT_KEYS,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Unknown field "completely_unrelated"');
    expect(errors[0]).not.toContain("did you mean");
  });

  it("reports multiple unknown fields", () => {
    const errors = checkUnknownFields(
      "report_result",
      { status: "clean", stateId: "review" },
      REPORT_RESULT_KEYS,
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('"status"');
    expect(errors[1]).toContain('"stateId"');
  });
});
