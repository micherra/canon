/**
 * Completeness test for the flow-schema.ts split.
 *
 * Verifies that the 3 bounded-context schema files export the expected names
 * and that no name appears in more than one file.
 *
 * Type-only exports (`export type`) are verified at compile time by TypeScript;
 * they do not exist at runtime and therefore cannot be tested here.
 *
 * This test acts as a regression guard: any schema accidentally removed from
 * a new file will cause the assertion to fail.
 */

import { describe, expect, it } from "vitest";
import * as boardStateSchemas from "../board-state-schemas.ts";
import * as eventSchemas from "../event-schemas.ts";
// Three new schema files — the canonical source of truth after flow-schema.ts was deleted
import * as flowDefSchemas from "../flow-definition-schemas.ts";

// Value-level exports that were in the original flow-schema.ts (schemas, constants — not type-only)
const EXPECTED_FLOW_DEF_EXPORTS = [
  "STATUS_KEYWORDS",
  "STATUS_ALIASES",
  "StateTypeSchema",
  "StuckWhenSchema",
  "SkipWhenSchema",
  "ContextInjectionSchema",
  "ConsultationsMapSchema",
  "RoleEntrySchema",
  "EffectTypeSchema",
  "EffectSchema",
  "RequiredArtifactSchema",
  "CompeteConfigObjectSchema",
  "CompeteConfigSchema",
  "DebateConfigSchema",
  "GateResultSchema",
  "DiscoveredGateSchema",
  "PostconditionAssertionSchema",
  "PostconditionResultSchema",
  "ViolationSeveritiesSchema",
  "TestResultsSchema",
  "BaselineEvidenceSchema",
  "ToolOverridesSchema",
  "SingleStateSchema",
  "WavePolicySchema",
  "WaveStateSchema",
  "ParallelStateSchema",
  "ParallelPerStateSchema",
  "TerminalStateSchema",
  "StateDefinitionSchema",
  "FragmentIncludeSchema",
  "FlowDefinitionSchema",
  "TypedParamSchema",
  "FragmentParamValueSchema",
  "FragmentStateDefinitionSchema",
  "FragmentDefinitionSchema",
  "ConsultationFragmentSchema",
  "ResolvedFlowSchema",
  // newly exported from this file (were private in flow-schema.ts)
  "BaseStateFields",
  "FragmentBaseStateFields",
] as const;

const EXPECTED_BOARD_STATE_EXPORTS = [
  "BoardStateStatusSchema",
  "ConsultationResultSchema",
  "WorktreeEntrySchema",
  "WaveResultSchema",
  "StateMetricsSchema",
  "AgentMetricsSchema",
  "ArtifactHistoryEntrySchema",
  "BoardStateEntrySchema",
  "CannotFixItemSchema",
  "ViolationHistoryEntrySchema",
  "FileTestHistoryEntrySchema",
  "StatusHistoryEntrySchema",
  "ProgressHistoryEntrySchema",
  "GateProgressHistoryEntrySchema",
  "HistoryEntrySchema",
  "IterationEntrySchema",
  "BlockedInfoSchema",
  "ConcernEntrySchema",
  "BoardSchema",
  "SessionSchema",
] as const;

const EXPECTED_EVENT_EXPORTS = ["TranscriptEntrySchema"] as const;

describe("schema-split-completeness", () => {
  it("flow-definition-schemas.ts exports all flow/state definition schemas", () => {
    for (const name of EXPECTED_FLOW_DEF_EXPORTS) {
      expect(
        name in (flowDefSchemas as Record<string, unknown>),
        `Expected "${name}" in flow-definition-schemas.ts`,
      ).toBe(true);
    }
  });

  it("board-state-schemas.ts exports all board/session runtime schemas", () => {
    for (const name of EXPECTED_BOARD_STATE_EXPORTS) {
      expect(
        name in (boardStateSchemas as Record<string, unknown>),
        `Expected "${name}" in board-state-schemas.ts`,
      ).toBe(true);
    }
  });

  it("event-schemas.ts exports TranscriptEntrySchema", () => {
    for (const name of EXPECTED_EVENT_EXPORTS) {
      expect(
        name in (eventSchemas as Record<string, unknown>),
        `Expected "${name}" in event-schemas.ts`,
      ).toBe(true);
    }
  });

  it("BaseStateFields and FragmentBaseStateFields are newly exported from flow-definition-schemas.ts", () => {
    const NEW_ONLY_EXPORTS = ["BaseStateFields", "FragmentBaseStateFields"] as const;
    for (const name of NEW_ONLY_EXPORTS) {
      expect(
        name in (flowDefSchemas as Record<string, unknown>),
        `Expected "${name}" to be exported from flow-definition-schemas.ts`,
      ).toBe(true);
    }
  });

  it("no export appears in more than one new schema file", () => {
    const newFiles = {
      "board-state-schemas.ts": boardStateSchemas as Record<string, unknown>,
      "event-schemas.ts": eventSchemas as Record<string, unknown>,
      "flow-definition-schemas.ts": flowDefSchemas as Record<string, unknown>,
    };

    // Collect all exported names across all 3 new files
    const allNewExports = Object.entries(newFiles).flatMap(([fileName, exports]) =>
      Object.keys(exports).map((name) => ({ fileName, name })),
    );

    // Group by name
    const byName = new Map<string, string[]>();
    for (const { name, fileName } of allNewExports) {
      const existing = byName.get(name) ?? [];
      byName.set(name, [...existing, fileName]);
    }

    // Assert no duplicates
    for (const [name, files] of byName.entries()) {
      expect(files.length, `Export "${name}" appears in multiple files: ${files.join(", ")}`).toBe(
        1,
      );
    }
  });

  it("every expected export from EXPECTED_FLOW_DEF_EXPORTS exists in exactly flow-definition-schemas.ts", () => {
    const allThreeFiles = {
      "board-state-schemas.ts": boardStateSchemas as Record<string, unknown>,
      "event-schemas.ts": eventSchemas as Record<string, unknown>,
      "flow-definition-schemas.ts": flowDefSchemas as Record<string, unknown>,
    };

    // Exclude the NEW_ONLY_EXPORTS (BaseStateFields, FragmentBaseStateFields) from "original" checks
    const originalValueExports = EXPECTED_FLOW_DEF_EXPORTS.filter(
      (name) => name !== "BaseStateFields" && name !== "FragmentBaseStateFields",
    );

    for (const name of originalValueExports) {
      const foundIn = Object.entries(allThreeFiles)
        .filter(([, exports]) => name in exports)
        .map(([fileName]) => fileName);

      expect(
        foundIn.length,
        `Expected "${name}" to be in exactly one new file, found in: [${foundIn.join(", ") || "none"}]`,
      ).toBe(1);
    }
  });
});
