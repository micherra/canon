/**
 * bridge-types.ts
 *
 * Transport-agnostic type definitions for the Canon UI bridge layer.
 * All Svelte components depend on this interface; transport details
 * are hidden in bridge-mcp-app.ts and bridge-http.ts.
 */

/** Annotation attached to a planning brief item by the user in the browser. */
export type Annotation = {
  /** The section this annotation belongs to (e.g., "assumptions", "criteria"). */
  section: string;
  /** Zero-based index of the item within the section. */
  itemIndex: number;
  /** The user's annotation text. */
  text: string;
  /** ISO-8601 timestamp when the annotation was created. */
  timestamp: string;
};

/** User's final decision on an artifact. */
export type Decision = {
  /** Whether the user approved or requested changes to the artifact. */
  action: "approve" | "request_changes";
  /** Annotations attached to specific items in the artifact. */
  annotations: Annotation[];
  /** Optional free-text feedback accompanying the decision. */
  feedback?: string;
};

/**
 * Transport-agnostic bridge interface for Svelte components.
 *
 * Implementations: createMcpAppBridge() (bridge-mcp-app.ts) and
 * createHttpBridge() (bridge-http.ts). The factory in bridge.ts
 * auto-detects the correct transport.
 */
export type BridgeAdapter = {
  /** Initialize the transport connection. No-op for HTTP; connects to MCP App for MCP App transport. */
  init(): Promise<void>;
  /**
   * Load the initial data payload from the transport.
   * @returns The typed data payload for this view.
   * @throws When no data is available (HTTP: window.__CANON_DATA__ missing; MCP App: tool result error).
   */
  loadData<T>(): Promise<T>;
  /**
   * Submit the user's decision (approve/request_changes) with annotations.
   * @param decision - The decision to submit, including annotations and optional feedback.
   * @throws When the submission fails (HTTP: non-2xx response or missing URL; MCP App: transport error).
   */
  submitDecision(decision: Decision): Promise<void>;
  /**
   * Send a prompt message back to the host (used by interactive components).
   * Not supported in HTTP bridge mode — logs a warning instead of throwing.
   * @param text - The message text to send.
   */
  sendMessage(text: string): Promise<void>;
};
