[2026-03-28 08:30] - Updated by Junie
{
    "TYPE": "correction",
    "CATEGORY": "scope clarification",
    "EXPECTATION": "The user wants a concrete scan of the codebase to find specific else/catch blocks that can be simplified, not just a general explanation of principles.",
    "NEW INSTRUCTION": "WHEN asked to check code for simplifications THEN identify specific files/lines and propose concrete refactors"
}

[2026-03-28 08:31] - Updated by Junie
{
    "TYPE": "correction",
    "CATEGORY": "scope verification",
    "EXPECTATION": "They expect honest, evidence-based auditing with specific files/lines reviewed, not broad claims of whole-codebase changes.",
    "NEW INSTRUCTION": "WHEN summarizing a codebase audit THEN list inspected files and state any limits"
}

[2026-03-28 08:42] - Updated by Junie
{
    "TYPE": "negative",
    "CATEGORY": "insufficient scope",
    "EXPECTATION": "They expected a truly deep pass affecting more than a handful of files, with concrete evidence of breadth.",
    "NEW INSTRUCTION": "WHEN performing a 'deep' audit THEN list all inspected files and specific lines changed"
}

[2026-03-28 08:53] - Updated by Junie
{
    "TYPE": "correction",
    "CATEGORY": "convention consistency",
    "EXPECTATION": "They want a single, consistent import-extension rule that matches actual project usage (.ts in TS-only runs) or code changed to match the documented .js rule, with no contradictions.",
    "NEW INSTRUCTION": "WHEN proposing import-extension conventions or editing imports THEN scan repo/tests for current style and toolchain, then enforce one consistent rule"
}

