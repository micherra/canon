# Wave Bulletin Coordination

This is the canonical protocol for inter-agent communication during parallel execution (waves, parallel, parallel-per states).

## When This Applies

Your spawn prompt will include a "Wave Coordination" section with your workspace path and wave number when you're running alongside other agents. If no wave context is present, skip this protocol entirely.

## Reading the Bulletin

**Check the bulletin once at the start of your task** (before producing output):

1. Call `get_wave_bulletin` with your workspace and wave number
2. Look for messages relevant to your work:
   - `created_utility` / `established_pattern` — reusable code or types a peer already created. Import from their path instead of recreating.
   - `discovered_gotcha` — environment issues, flaky tests, breaking discoveries. Adjust your approach accordingly.
   - `established_convention` — naming or structural decisions a peer already made. Follow them for consistency.
   - `contract_deviation` — a peer changed a shared type or API boundary from what CONTRACTS.md specifies. If your task consumes that contract, adapt to the actual implementation, not the original contract.
   - `decision_revised` — a peer found that a design decision doesn't hold up. If your task references the same decision, follow the revised understanding.

## Posting to the Bulletin

Post **immediately** when you produce something peers should know about:

**After creating something reusable** (shared utility, type, helper, test fixture, pattern):
1. Call `post_wave_bulletin` with type `created_utility` or `established_pattern`
2. Include `path` and `exports` in the detail so peers can find it

**After discovering a gotcha** (unexpected env issue, flaky test, breaking discovery):
1. Call `post_wave_bulletin` with type `discovered_gotcha`
2. Include the `issue` in the detail

**After establishing a convention** (naming pattern, file structure decision, API shape):
1. Call `post_wave_bulletin` with type `established_convention`
2. Include what you decided and why

**After deviating from a shared contract** (changed a type signature, API boundary, or return type from CONTRACTS.md):
1. Call `post_wave_bulletin` with type `contract_deviation`
2. Include the contract item, what was planned, and what you actually implemented
3. This is critical — same-wave peers consuming that contract need to know immediately

**After finding a design decision doesn't hold** (decision from `${WORKSPACE}/decisions/` proved wrong during implementation):
1. Call `post_wave_bulletin` with type `decision_revised`
2. Include the decision ID and what changed
3. Same-wave peers referencing that decision need the updated understanding

## Timing

- Read once at the start, once before creating any shared artifact
- Post immediately after creating shared artifacts or discovering gotchas
- Don't poll repeatedly — this isn't a chat channel
