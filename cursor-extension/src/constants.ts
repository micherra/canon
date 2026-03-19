/** Shared constants for the Canon VS Code extension. */

export const CANON_DIR = ".canon";

export const FILES = {
  GRAPH_DATA: "graph-data.json",
  SUMMARIES: "summaries.json",
  DASHBOARD_STATE: "dashboard-state.json",
  PR_REVIEWS: "pr-reviews.jsonl",
} as const;

export const TIMEOUTS = {
  POLL_INTERVAL_MS: 2000,
  GENERATION_TIMEOUT_MS: 600_000,
  POLL_TIMEOUT_MS: 300_000,
  FILE_WATCHER_DEBOUNCE_MS: 500,
  ACTIVE_FILE_DEBOUNCE_MS: 500,
  REQUEST_TIMEOUT_MS: 30_000,
} as const;
