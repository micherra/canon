/** Shared git ref validation utilities. */

const GIT_REF_PATTERN = /^[a-zA-Z0-9_./-]+$/;

/**
 * Validates and returns a git ref string.
 * Throws if the ref contains unsafe characters, starts with '-', or contains '..'.
 */
export function sanitizeGitRef(ref: string): string {
  if (!ref || !GIT_REF_PATTERN.test(ref)) {
    throw new Error(`Invalid git ref: "${ref}". Only alphanumeric, '.', '/', '_', '-' allowed.`);
  }
  if (ref.startsWith("-")) {
    throw new Error(`Invalid git ref: "${ref}". Refs must not start with '-'.`);
  }
  if (ref.includes("..")) {
    throw new Error(`Invalid git ref: "${ref}". Refs must not contain '..'.`);
  }
  return ref;
}
