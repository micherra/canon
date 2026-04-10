/**
 * Branded domain identifier types for Canon orchestration.
 *
 * These are Zod-branded string schemas that create nominal types for
 * domain identifiers. Using branded types prevents accidental interchange
 * of domain identifiers at compile time.
 *
 * This file is intentionally free of circular dependencies:
 * - board-state-schemas.ts imports from here
 * - flow-definition-schemas.ts imports from here
 * Neither imports the other for branded types.
 *
 * See: ubiquitous-language-in-code, aggregates-reference-by-id
 */

import { z } from "zod";

// WorkspacePath — absolute filesystem path to a Canon workspace directory

export const WorkspacePathSchema = z.string().min(1).brand<"WorkspacePath">();
export type WorkspacePath = z.infer<typeof WorkspacePathSchema>;
export const workspacePath = (raw: string): WorkspacePath => WorkspacePathSchema.parse(raw);

// StateId — identifier for a flow state node

export const StateIdSchema = z.string().brand<"StateId">();
export type StateId = z.infer<typeof StateIdSchema>;
export const stateId = (raw: string): StateId => StateIdSchema.parse(raw);

// FlowName — name of a Canon flow definition

export const FlowNameSchema = z.string().brand<"FlowName">();
export type FlowName = z.infer<typeof FlowNameSchema>;
export const flowName = (raw: string): FlowName => FlowNameSchema.parse(raw);
