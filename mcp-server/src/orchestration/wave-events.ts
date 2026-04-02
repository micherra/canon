/**
 * Wave event utilities — pure helpers only.
 *
 * All I/O (postWaveEvent, readPendingEvents, readAllEvents, markEventApplied,
 * markEventRejected) has been removed. Use ExecutionStore methods instead:
 *   store.postWaveEvent(event)
 *   store.getWaveEvents({ status: 'pending' })
 *   store.getWaveEvents()
 *   store.updateWaveEvent(id, { status: 'applied', applied_at, resolution })
 *   store.updateWaveEvent(id, { status: 'rejected', rejection_reason })
 *
 * This file retains only the pure resolveEventAgents function and re-exports
 * the types consumed by other modules.
 */

// Re-export types consumed by callers that import from this module.
export type { WaveEvent, WaveEventResolution, WaveEventType } from "./flow-schema.ts";

/**
 * Pure lookup: returns which agents (if any) need to be spawned to handle
 * a given wave event type, along with per-agent spawn descriptions.
 */
export function resolveEventAgents(eventType: import("./flow-schema.ts").WaveEventType): {
  agents: string[];
  descriptions: Record<string, string>;
} {
  switch (eventType) {
    case "add_task":
      return {
        agents: ["canon-architect"],
        descriptions: {
          "canon-architect": "Break down the new task into a plan and slot it into INDEX.md",
        },
      };
    case "skip_task":
      return { agents: [], descriptions: {} };
    case "reprioritize":
      return {
        agents: ["canon-architect"],
        descriptions: {
          "canon-architect": "Validate dependency ordering after reprioritization",
        },
      };
    case "inject_context":
      // Researcher is optional; orchestrator decides
      return { agents: [], descriptions: {} };
    case "guidance":
      // Guidance is a mechanical orchestrator operation — write user text
      // to waves/guidance.md via writeWaveGuidance(). No agent needed.
      return { agents: [], descriptions: {} };
    case "pause":
      return { agents: [], descriptions: {} };
    default: {
      void eventType;
      return { agents: [], descriptions: {} };
    }
  }
}
