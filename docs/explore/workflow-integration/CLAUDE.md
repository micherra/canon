# Workflow-Integration Design Competition — Agent Guidelines

## Purpose

This directory persists the artifacts from the 2026-06-07 design competition that decided how the Claude Code `Workflow` tool should be integrated into Canon. These documents are historical record and decided design — they are not aspirational or exploratory.

## Authoritative source

**SYNTHESIS.md is the authoritative design.** It supersedes PROPOSAL-A, PROPOSAL-B, and PROPOSAL-C for all decision-making purposes. The proposals are appendices — read them to understand the reasoning behind the synthesis, not to derive current design intent.

Do not treat PROPOSAL-A, PROPOSAL-B, or PROPOSAL-C as current design documents. The synthesis incorporated the best elements of each; the proposals themselves represent paths not fully taken.

## Key decisions (already made — do not reopen without user direction)

- Default-on adoption: eligible runbook steps default to their workflow engine; `engine: direct` is the audited opt-out.
- Supervised carve-out is a standing posture (not a permanent invariant): revisit at the Inc-7 decision.
- Endgame compiler/runner (SYNTHESIS §3.4) is a fresh future decision, evidence-gated on 5 conditions.
- In-segment pre-verdict auto-fix is permanently rejected.
- Near-term commitment: Increments 0–3 only.

## workflow-tool-spec.md

This file contains the authoritative Workflow tool spec (what the harness tool can actually do). Reference it when implementing any workflow-related feature. It is independent of the competition and has standalone reference value.

## CAPABILITY-REVIEW.md

The shared neutral fact base (19 Canon mechanisms × Workflow primitives, 6 hard conflicts, constraint ledger). Reference it when designing new workflow features to verify constraint compliance.

## Do not modify these files

These files are a historical record. Changes require explicit user direction and should note what decision is being updated and why.
