# Scoping: What would it take to unlock an AUTOMATIC craft (+compliance) signal?

Status: SHELVED (2026-06-05) — folded into docs/supervised-build-quality.md; taxonomy (Pieces A/D) killed by user decision, Piece B kept on backlog. Original: EXPLORE / scoping only (2026-06-03).

## TL;DR
The prerequisite is SMALLER than assumed, because two of the three inputs are mostly already there:
- **Compliance score: already populated.** 59/64 reviews carry nonzero score tallies; recent reviews show real `rules/opinions/conventions` passed/total. The "all-zeros" from the craft-v2 investigation was old/stub rows. reviewer.md already instructs real counting (lines 333-345); plumbing already passes it through. **This half is ~done.**
- **Change-size denominator: computed but dropped.** `evaluate-step.ts` computes `diff_stats`, but `tryAppendAnalytics` never writes `diff_stat`/`total_files_changed` onto the persisted FlowRunEntry (0/340). Small wiring fix at the finalize seam.
- **The real missing input is the intent/severity on the CRAFT (recommendations) stream.** `violations[]` already has `severity` (rule/strong-opinion/convention) — populated. `recommendations[]` (the holistic/craft stream) has only `{file_path?, title, message, source}` — no severity, no intent type (defect/suggestion/praise/question). That gap is what makes craft auto-derivation impossible AND is exactly what made v1 a comment-volume proxy (99 holistic = nits+praise+size).

## What an automatic measure would need (and what it unlocks)
With (a) intent+severity on craft findings, (b) the diff_stat denominator wired, you can compute:
- **severity-weighted DEFECT density per craft dimension / KLOC**, intent-filtered so praise/suggestions/questions don't count against craft.
- Auto-derivable dimensions: **Locality/cleanliness** (dead code, lint), partially **Simplicity** (complexity/lint signals) and **Predictability** (side-effect lints). Still judgment-only even with this data: **Cohesion, Interface-depth, Naming** — these need semantic judgment no counter captures.
- => Even fully built, only ~2 of 6 dimensions become trustworthy-automatic; 3-4 stay reviewer-judged. The automatic signal AUGMENTS the v2 rubric, it does not replace it.

## Sizing
- **Piece A — intent/severity taxonomy on craft findings**: MEDIUM. Touches the contract (`schema.ts` recommendations OR a new structured craft-finding), reviewer.md emission, store_pr_review/report validation, drift store, any rendering. The taxonomy VALUES (which severities, which intents) is a user decision before any build.
- **Piece B — diff_stat denominator wiring**: SMALL. Aggregate `evaluate-step` diff_stats into the FlowRunEntry at finalize. Mostly a plumbing fix.
- **Piece C — compliance score**: XS / mostly done. Optional backfill of the 5 zero rows; otherwise leave it.
- **Piece D — density metric + learner dimension**: MEDIUM, but only worth building AFTER A+B accumulate data.

Sequence: taxonomy contract (A) → reviewer emission (A) → diff_stat wiring (B) → [accumulate N reviews] → density metric (D). Riskiest/most-uncertain: the taxonomy itself (values call) and whether reviewers apply intent labels consistently enough that the density number is trustworthy — the same human-consistency risk that dogged v1, just pushed up one level.

## Honest lean
Marginal. The highest-leverage input (compliance score) is already populated, and craft's most meaningful dimensions (cohesion/interface/naming) stay judgment-only no matter what. Building the taxonomy buys a trustworthy automatic number for ~2 of 6 dimensions at the cost of real reviewer-overhead and a values decision. Recommend: do Piece B (diff_stat wiring, small, useful regardless) opportunistically; SHELVE the taxonomy build unless the user specifically wants an automatic craft GATE — for which a defect-density floor on 2 dimensions could be a defensible first gate.

## Decisions to greenlight or shelve
1. **Is the goal an automatic craft GATE, or just richer trend numbers?** Gate → taxonomy is justified (you need an objective floor). Trend-only → reviewer-judged v2 already trends; taxonomy is low ROI.
2. **Will you commit to a finding intent/severity taxonomy (the values call)?** Define the intents (defect/suggestion/praise/question) and severities. Without this the build can't start; with it, ~2 dimensions become automatic.
