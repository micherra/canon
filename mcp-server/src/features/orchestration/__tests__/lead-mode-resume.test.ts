import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterPendingDescriptors,
  parseRunbook,
  planRun,
  type SpawnDescriptor,
} from "../lead-mode.ts";

/**
 * Cross-session resume tests for the lead-mode filterPendingDescriptors
 * helper. Kept in a sibling file so the Phase 1 lead-mode.test.ts stays
 * untouched (it was reviewed and signed off as-is).
 */

const VALID_RUNBOOK_YAML = `
name: fast-path
description: Bug fix or small change, 1–3 files
tier: small
steps:
  - role: canon-researcher
    task_type: research
    artifact: research_synthesis
    artifact_path: research/SYNTHESIS.md
    hitl: false
    required_artifacts: []
  - role: canon-architect
    task_type: design
    artifact: plan_index
    artifact_path: plans/INDEX.md
    hitl: after
    required_artifacts:
      - research_synthesis
  - role: canon-implementor
    task_type: implement
    artifact: implementation_summary
    artifact_path: plans/SUMMARY.md
    hitl: false
    required_artifacts:
      - research_synthesis
      - plan_index
  - role: canon-reviewer
    task_type: review
    artifact: review
    artifact_path: reviews/REVIEW.md
    hitl: after_if_verdict_not_clean
    required_artifacts:
      - implementation_summary
`;

function buildDescriptors(): SpawnDescriptor[] {
  const runbook = parseRunbook(VALID_RUNBOOK_YAML);
  return planRun({
    runbook,
    target_files: [],
    workspace_id: "ws-resume",
  });
}

describe("filterPendingDescriptors", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "canon-lead-resume-"));
  });

  afterEach(async () => {
    await rm(tmp, { force: true, recursive: true });
  });

  it("returns all descriptors when the task list is empty", () => {
    const descriptors = buildDescriptors();
    const pending = filterPendingDescriptors(descriptors, {
      task_list_id: "nope",
      tasks_root: tmp,
    });
    expect(pending).toEqual(descriptors);
  });

  it("returns all descriptors when CLAUDE_CODE_TASK_LIST_ID is unset", () => {
    const descriptors = buildDescriptors();
    const prev = process.env.CLAUDE_CODE_TASK_LIST_ID;
    delete process.env.CLAUDE_CODE_TASK_LIST_ID;
    try {
      const pending = filterPendingDescriptors(descriptors, { tasks_root: tmp });
      expect(pending).toEqual(descriptors);
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CODE_TASK_LIST_ID = prev;
    }
  });

  it("skips descriptors whose task id is marked completed", async () => {
    const descriptors = buildDescriptors();
    const listDir = join(tmp, "ws");
    await mkdir(listDir, { recursive: true });
    // Mark researcher + architect as completed; implementor + reviewer still pending.
    await Promise.all([
      ...descriptors
        .slice(0, 2)
        .map((d) =>
          writeFile(
            join(listDir, `${d.task_id}.json`),
            JSON.stringify({ content: "", id: d.task_id, status: "completed" }),
          ),
        ),
      ...descriptors
        .slice(2)
        .map((d) =>
          writeFile(
            join(listDir, `${d.task_id}.json`),
            JSON.stringify({ content: "", id: d.task_id, status: "pending" }),
          ),
        ),
    ]);

    const pending = filterPendingDescriptors(descriptors, {
      task_list_id: "ws",
      tasks_root: tmp,
    });
    expect(pending.map((d) => d.role)).toEqual(["canon-implementor", "canon-reviewer"]);
  });

  it("returns an empty list when every task is completed", async () => {
    const descriptors = buildDescriptors();
    const listDir = join(tmp, "ws");
    await mkdir(listDir, { recursive: true });
    await Promise.all(
      descriptors.map((d) =>
        writeFile(
          join(listDir, `${d.task_id}.json`),
          JSON.stringify({ content: "", id: d.task_id, status: "completed" }),
        ),
      ),
    );

    const pending = filterPendingDescriptors(descriptors, {
      task_list_id: "ws",
      tasks_root: tmp,
    });
    expect(pending).toEqual([]);
  });

  it("ignores task-list entries whose id does not match any descriptor", async () => {
    const descriptors = buildDescriptors();
    const listDir = join(tmp, "ws");
    await mkdir(listDir, { recursive: true });
    await writeFile(
      join(listDir, "random.json"),
      JSON.stringify({ content: "", id: "random-other-id", status: "completed" }),
    );

    const pending = filterPendingDescriptors(descriptors, {
      task_list_id: "ws",
      tasks_root: tmp,
    });
    expect(pending).toEqual(descriptors);
  });

  it("treats in_progress tasks as still pending", async () => {
    const descriptors = buildDescriptors();
    const listDir = join(tmp, "ws");
    await mkdir(listDir, { recursive: true });
    await writeFile(
      join(listDir, `${descriptors[0]!.task_id}.json`),
      JSON.stringify({
        content: "",
        id: descriptors[0]!.task_id,
        status: "in_progress",
      }),
    );

    const pending = filterPendingDescriptors(descriptors, {
      task_list_id: "ws",
      tasks_root: tmp,
    });
    // in_progress ≠ completed, so the first descriptor is still in the
    // pending set.
    expect(pending).toEqual(descriptors);
  });

  it("does not mutate the input descriptor list", () => {
    const descriptors = buildDescriptors();
    const before = [...descriptors];
    filterPendingDescriptors(descriptors, {
      task_list_id: "nope",
      tasks_root: tmp,
    });
    expect(descriptors).toEqual(before);
  });
});
