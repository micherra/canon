/**
 * Flow definition types for Canon's lightweight pipeline system.
 *
 * Flows are YAML files in .canon/flows/ that define agent orchestration
 * patterns. They are NOT a general-purpose workflow engine — just Canon's
 * own predefined pipeline variations.
 */

export interface FlowStep {
  /** Unique step identifier within the flow */
  id: string;
  /** Agent to spawn (e.g., "canon-reviewer", "canon-refactorer") */
  agent?: string;
  /** Canon command to run (e.g., "canon:build") */
  command?: string;
  /** Input context key — references output from a previous step */
  input?: string;
  /** Run multiple instances in parallel with these dimensions */
  parallel?: string[];
  /** Run one instance per item in this context key (e.g., "violation_group") */
  parallel_per?: string;
  /** Run tasks in waves (sequential groups with parallel within each) */
  wave?: boolean;
  /** Condition to keep looping (simple expression: "verdict == CLEAN") */
  loop_until?: string;
  /** Steps to run when violations are found */
  on_violation?: FlowStep[];
  /** Steps to run on failure */
  on_failure?: FlowStep[];
  /** Jump to another step ID */
  goto?: string;
  /** Max iterations for loop steps */
  max_iterations?: number;
  /** Pass through flags from the parent command */
  passthrough_flags?: boolean;
}

export interface FlowDefinition {
  /** Flow name (matches filename without extension) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Global max iterations for any loop in this flow */
  max_iterations?: number;
  /** Ordered list of steps */
  steps: FlowStep[];
}

export interface FlowStepResult {
  step_id: string;
  status: "completed" | "failed" | "skipped" | "blocked";
  agent?: string;
  verdict?: string;
  duration_ms?: number;
  output?: Record<string, unknown>;
  error?: string;
}

export interface FlowResult {
  flow_name: string;
  status: "success" | "failed" | "stuck" | "max_iterations";
  steps_completed: number;
  total_steps: number;
  step_results: FlowStepResult[];
  started_at: string;
  completed_at: string;
}

export interface FlowValidationError {
  step_id?: string;
  field: string;
  message: string;
}

export interface FlowValidationResult {
  valid: boolean;
  errors: FlowValidationError[];
  warnings: string[];
}
