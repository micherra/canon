import { randomBytes } from "crypto";
import { EventStore } from "../drift/event-store.js";
import type { OrchestrationEvent } from "../schema.js";
import type { FlowDefinition, FlowStepResult, FlowResult } from "./types.js";

/**
 * Flow runner — executes a flow definition step by step.
 *
 * This is a lightweight runner that tracks execution state and emits events.
 * Actual agent spawning happens in the command layer (commands/flow.md) which
 * has access to Claude Code's Agent tool. The runner provides structure and
 * event emission.
 */
export class FlowRunner {
  private eventStore: EventStore;
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.eventStore = new EventStore(projectDir);
  }

  /**
   * Create a flow execution context with tracking state.
   */
  createExecution(flow: FlowDefinition, taskSlug: string): FlowExecution {
    return new FlowExecution(flow, taskSlug, this.eventStore);
  }
}

export class FlowExecution {
  readonly flow: FlowDefinition;
  readonly taskSlug: string;
  private eventStore: EventStore;
  private stepResults: FlowStepResult[] = [];
  private startedAt: string;
  private currentStepIndex = 0;

  constructor(
    flow: FlowDefinition,
    taskSlug: string,
    eventStore: EventStore
  ) {
    this.flow = flow;
    this.taskSlug = taskSlug;
    this.eventStore = eventStore;
    this.startedAt = new Date().toISOString();
  }

  /**
   * Emit a flow_start event.
   */
  async start(): Promise<void> {
    await this.emitEvent("flow_start", {
      details: {
        flow_name: this.flow.name,
        total_steps: this.flow.steps.length,
      },
    });
  }

  /**
   * Get the next step to execute, or null if done.
   */
  getNextStep(): { step: FlowDefinition["steps"][number]; index: number } | null {
    if (this.currentStepIndex >= this.flow.steps.length) return null;
    return {
      step: this.flow.steps[this.currentStepIndex],
      index: this.currentStepIndex,
    };
  }

  /**
   * Record a step starting.
   */
  async markStepStarted(stepId: string): Promise<void> {
    await this.emitEvent("phase_start", {
      phase: stepId,
      agent_name: this.flow.steps.find((s) => s.id === stepId)?.agent,
    });
  }

  /**
   * Record a step result and advance to the next step.
   */
  async recordStepResult(result: FlowStepResult): Promise<void> {
    this.stepResults.push(result);
    this.currentStepIndex++;

    await this.emitEvent("phase_end", {
      phase: result.step_id,
      agent_name: result.agent,
      status: result.status,
      details: {
        verdict: result.verdict,
        duration_ms: result.duration_ms,
      },
    });
  }

  /**
   * Record a loop iteration event.
   */
  async recordLoopIteration(
    stepId: string,
    iteration: number,
    verdict?: string
  ): Promise<void> {
    await this.emitEvent("loop_iteration", {
      phase: stepId,
      iteration,
      details: { verdict },
    });
  }

  /**
   * Handle a goto — jump to a specific step.
   */
  jumpToStep(stepId: string): boolean {
    const idx = this.flow.steps.findIndex((s) => s.id === stepId);
    if (idx === -1) return false;
    this.currentStepIndex = idx;
    return true;
  }

  /**
   * Finalize the flow execution and return the result.
   */
  async finish(
    status: FlowResult["status"] = "success"
  ): Promise<FlowResult> {
    const result: FlowResult = {
      flow_name: this.flow.name,
      status,
      steps_completed: this.stepResults.filter(
        (r) => r.status === "completed"
      ).length,
      total_steps: this.flow.steps.length,
      step_results: this.stepResults,
      started_at: this.startedAt,
      completed_at: new Date().toISOString(),
    };

    await this.emitEvent("flow_end", {
      status: status,
      details: {
        steps_completed: result.steps_completed,
        total_steps: result.total_steps,
      },
    });

    return result;
  }

  /**
   * Get current execution state (for status queries).
   */
  getState(): {
    flow_name: string;
    current_step: number;
    total_steps: number;
    step_results: FlowStepResult[];
  } {
    return {
      flow_name: this.flow.name,
      current_step: this.currentStepIndex,
      total_steps: this.flow.steps.length,
      step_results: [...this.stepResults],
    };
  }

  private async emitEvent(
    eventType: OrchestrationEvent["event_type"],
    extra: Partial<OrchestrationEvent> = {}
  ): Promise<void> {
    const event: OrchestrationEvent = {
      event_id: generateEventId(),
      timestamp: new Date().toISOString(),
      event_type: eventType,
      task_slug: this.taskSlug,
      ...extra,
    };
    await this.eventStore.appendEvent(event);
  }
}

function generateEventId(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `evt_${y}${m}${d}_${randomBytes(3).toString("hex")}`;
}
