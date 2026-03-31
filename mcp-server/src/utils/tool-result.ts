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

/** Shared subprocess result type — returned by all adapter functions. */
export interface ProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}
