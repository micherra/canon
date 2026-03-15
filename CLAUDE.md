# Canon — Project Guidelines

## Rate Limit Handling

All agent spawns may encounter API rate limits. When any agent spawn fails with a rate limit error (e.g. "Rate limit reached", HTTP 429, or "overloaded"):

- Retry up to 3 times with exponential backoff: wait 4 seconds before retry #1, 8 seconds before retry #2, and 16 seconds before retry #3.
- If spawning multiple agents in parallel and some succeed while others are rate-limited, keep the successful results and only retry the failed ones.
- If all retries for a given agent fail, inform the user and pause. Do NOT skip the phase — wait for the user to confirm retry or abort.
