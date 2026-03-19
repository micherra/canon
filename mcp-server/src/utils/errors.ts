/** Type guard for Node.js filesystem errors (ENOENT, EACCES, etc.) */
export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Check if an error is a file-not-found error. */
export function isNotFound(err: unknown): boolean {
  return isNodeError(err) && err.code === "ENOENT";
}
