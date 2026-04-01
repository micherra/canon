export type CanonErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "FLOW_NOT_FOUND"
  | "FLOW_PARSE_ERROR"
  | "KG_NOT_INDEXED"
  | "BOARD_LOCKED"
  | "CONVERGENCE_EXCEEDED"
  | "INVALID_INPUT"
  | "PREFLIGHT_FAILED"
  | "UNEXPECTED";

export interface CanonToolError {
  ok: false;
  error_code: CanonErrorCode;
  message: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}

export type ToolResult<T> = ({ ok: true } & T) | CanonToolError;

export function toolError(
  error_code: CanonErrorCode,
  message: string,
  recoverable = false,
  context?: Record<string, unknown>,
): CanonToolError {
  return { ok: false, error_code, message, recoverable, context };
}

export function toolOk<T extends Record<string, unknown>>(data: T): { ok: true } & T {
  return { ok: true, ...data };
}

export function isToolError(result: unknown): result is CanonToolError {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as any).ok === false &&
    "error_code" in result
  );
}

/**
 * Assert that a ToolResult is ok, narrowing the type to the success branch.
 * Throws if the result is an error. Intended for use in tests and places
 * where the caller knows the call should succeed.
 */
export function assertOk<T>(result: ToolResult<T>): asserts result is { ok: true } & T {
  if (!result.ok) {
    throw new Error(`assertOk: expected ok result but got error ${result.error_code}: ${result.message}`);
  }
}

/** Shared subprocess result type — returned by all adapter functions. */
export interface ProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}
