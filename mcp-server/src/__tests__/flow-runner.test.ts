import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { FlowRunner } from "../flow/runner.js";
import type { FlowDefinition } from "../flow/types.js";

describe("FlowRunner", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-flow-runner-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const simpleFlow: FlowDefinition = {
    name: "test-flow",
    description: "Test flow",
    steps: [
      { id: "step1", agent: "canon-reviewer" },
      { id: "step2", agent: "canon-refactorer" },
    ],
  };

  it("creates an execution and tracks steps", async () => {
    const runner = new FlowRunner(tmpDir);
    const exec = runner.createExecution(simpleFlow, "test-task");

    await exec.start();

    const next1 = exec.getNextStep();
    expect(next1).not.toBeNull();
    expect(next1!.step.id).toBe("step1");
    expect(next1!.index).toBe(0);

    await exec.markStepStarted("step1");
    await exec.recordStepResult({
      step_id: "step1",
      status: "completed",
      agent: "canon-reviewer",
      verdict: "WARNING",
    });

    const next2 = exec.getNextStep();
    expect(next2!.step.id).toBe("step2");

    await exec.recordStepResult({
      step_id: "step2",
      status: "completed",
      agent: "canon-refactorer",
    });

    const next3 = exec.getNextStep();
    expect(next3).toBeNull();

    const result = await exec.finish("success");
    expect(result.flow_name).toBe("test-flow");
    expect(result.status).toBe("success");
    expect(result.steps_completed).toBe(2);
    expect(result.step_results).toHaveLength(2);
  });

  it("handles jumpToStep for goto", async () => {
    const runner = new FlowRunner(tmpDir);
    const exec = runner.createExecution(simpleFlow, "test-task");

    await exec.start();
    exec.getNextStep(); // step1

    // Jump to step2
    const jumped = exec.jumpToStep("step2");
    expect(jumped).toBe(true);

    const next = exec.getNextStep();
    expect(next!.step.id).toBe("step2");
  });

  it("returns false for jumpToStep with unknown id", async () => {
    const runner = new FlowRunner(tmpDir);
    const exec = runner.createExecution(simpleFlow, "test-task");

    const jumped = exec.jumpToStep("nonexistent");
    expect(jumped).toBe(false);
  });

  it("records loop iterations", async () => {
    const runner = new FlowRunner(tmpDir);
    const exec = runner.createExecution(simpleFlow, "test-task");

    await exec.start();
    await exec.recordLoopIteration("step1", 1, "WARNING");
    await exec.recordLoopIteration("step1", 2, "CLEAN");

    // Verify events were written
    const eventsPath = join(tmpDir, ".canon", "orchestration-events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const events = content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));

    const loopEvents = events.filter(
      (e: any) => e.event_type === "loop_iteration"
    );
    expect(loopEvents).toHaveLength(2);
    expect(loopEvents[0].iteration).toBe(1);
    expect(loopEvents[1].iteration).toBe(2);
  });

  it("getState returns current execution state", async () => {
    const runner = new FlowRunner(tmpDir);
    const exec = runner.createExecution(simpleFlow, "test-task");

    await exec.start();
    await exec.recordStepResult({
      step_id: "step1",
      status: "completed",
      agent: "canon-reviewer",
    });

    const state = exec.getState();
    expect(state.flow_name).toBe("test-flow");
    expect(state.current_step).toBe(1);
    expect(state.total_steps).toBe(2);
    expect(state.step_results).toHaveLength(1);
  });

  it("emits flow_start and flow_end events", async () => {
    const runner = new FlowRunner(tmpDir);
    const exec = runner.createExecution(simpleFlow, "test-task");

    await exec.start();
    await exec.finish("success");

    const eventsPath = join(tmpDir, ".canon", "orchestration-events.jsonl");
    const content = await readFile(eventsPath, "utf-8");
    const events = content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));

    expect(events[0].event_type).toBe("flow_start");
    expect(events[events.length - 1].event_type).toBe("flow_end");
  });
});
