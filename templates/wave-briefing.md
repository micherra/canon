---
template: wave-briefing
description: Inter-wave learning briefing injected into next wave's spawn prompts
used-by: [canon-orchestrator]
read-by: [canon-implementor]
max_tokens: 500
---

# Template: Wave Briefing

The orchestrator populates this template between waves and injects it into implementor spawn prompts as `${wave_briefing}`. Omit sections that have no content.

## Wave Briefing (from wave ${wave})

### New shared code
<!-- Files with action "created" in shared directories from completed wave summaries -->
<!-- Format: - `path/to/file.ts` — description (created by task {task_id}) -->

### Patterns established
<!-- Conventions/patterns from Canon Compliance sections of summaries -->

### Gotchas
<!-- DONE_WITH_CONCERNS messages and unexpected behavior notes -->

<!-- Consultation sections inserted below by orchestrator -->
<!-- Each consultation fragment's output appears under its declared section heading -->
<!-- consultations.before sections appear first, then consultations.between sections -->
