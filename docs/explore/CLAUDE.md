# Canon Explore — Agent Guidelines

## Purpose

This directory holds design explorations, competed proposals, and research that informed Canon's architecture. Documents here have varying authority levels — always check a document's own status section before treating it as a current design constraint.

## Authority levels

- **Ratified** (e.g., `workflow-integration/SYNTHESIS.md`): a user HITL decision was recorded; treat the synthesis as current design. Do not treat the underlying proposals as current.
- **Parked**: analysis complete but no implementation decision was made; treat as background context.
- **Open**: under consideration; treat as input to design, not settled.

## Key ratified decisions in this directory

- **`workflow-integration/SYNTHESIS.md`**: the decided design for Workflow-tool integration (2026-06-07). Near-term commitment: Increments 0–3. Endgame (Inc 7) is a fresh future decision.

## Do not implement from proposals

Do not implement directly from PROPOSAL-A, PROPOSAL-B, or PROPOSAL-C in `workflow-integration/`. The synthesis resolved conflicts and grafted the best elements; the proposals represent paths not fully taken.
