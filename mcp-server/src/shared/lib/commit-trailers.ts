/**
 * commit-trailers.ts — Pure functions for formatting Canon git trailer blocks.
 *
 * Trailer format knowledge is encapsulated here. Callers never need to know
 * the `Canon-Workflow:` prefix syntax — they pass structured options and
 * receive a ready-to-embed string.
 */

/** Options for constructing a Canon git trailer block. */
export type TrailerOpts = {
  workflow: string;
  agent: string;
  state: string;
  taskId?: string;
};

const CO_AUTHORED_BY = "Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>";

/**
 * Format a Canon git trailer block from structured options.
 *
 * Returns a string like:
 *   Canon-Workflow: my-slug
 *   Canon-Agent: canon-implementor
 *   Canon-State: implement
 *   Canon-Task: task-01
 *
 * Rules:
 * - `Canon-Task` is only included when `taskId` is provided
 * - No trailing newline — the caller controls surrounding whitespace
 * - Returns empty string when any required field is empty (defensive guard)
 */
export const formatCommitTrailers = (opts: TrailerOpts): string => {
  if (!opts.workflow || !opts.agent || !opts.state) {
    return "";
  }

  const lines = [
    `Canon-Workflow: ${opts.workflow}`,
    `Canon-Agent: ${opts.agent}`,
    `Canon-State: ${opts.state}`,
  ];

  if (opts.taskId) {
    lines.push(`Canon-Task: ${opts.taskId}`);
  }

  return lines.join("\n");
};

/**
 * Assemble a full git commit message from a subject, optional body, and trailer opts.
 *
 * Structure when body is non-empty:
 *   {subject}
 *
 *   {body}
 *
 *   {trailers}
 *   Co-Authored-By: ...
 *
 * Structure when body is empty:
 *   {subject}
 *
 *   {trailers}
 *   Co-Authored-By: ...
 */
export const buildCommitMessage = (
  subject: string,
  body: string,
  trailerOpts: TrailerOpts,
): string => {
  const trailers = formatCommitTrailers(trailerOpts);
  const trailerSection = `${trailers}\n${CO_AUTHORED_BY}`;

  if (body) {
    return `${subject}\n\n${body}\n\n${trailerSection}`;
  }

  return `${subject}\n\n${trailerSection}`;
};
