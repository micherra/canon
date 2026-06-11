# scripts/

Standalone maintainer scripts for Canon. These are not invoked from `mcp-server/` and have no Canon-runtime coupling — they run directly via `bash`.

## mine-codex-comments.sh

Mines every `chatgpt-codex-connector[bot]` review comment across merged PRs in the Codex-activation window (#47+), clusters them into 9 recurring defect classes by keyword, ranks by `count × severity-weight` (P1=2, P2=1), and writes the durable artifact `docs/reference/codex-defect-classes.md`.

### Usage

```sh
bash scripts/mine-codex-comments.sh
```

### Requirements

- `gh` CLI authenticated with read access to the repo (`gh auth login`)
- `jq` (used internally by `gh --jq`)
- `awk`, `xargs`, `grep`, `sed` (standard POSIX — available on macOS and Linux)
- Authenticated `gh` is required: unauthenticated rate limits (60 req/hr) are insufficient for the ~275 API calls this script makes

### Output

Writes `docs/reference/codex-defect-classes.md` — a frequency-ranked table of the 9 Codex defect classes with per-class comment counts, P1/P2 breakdown, rank scores, sample findings, and NOT-WIRED notes for classes 8 and 9.

### Re-run cadence

Re-run quarterly, or whenever the corrective-build rate ticks up (>20% of recent builds are "address-codex" rework builds). The mine takes under 2 minutes with parallel `-P 8` fetching.

### Safety invariants

- The script is fail-closed (`set -euo pipefail`): if `gh` is unauthenticated or returns an error, the script exits non-zero rather than writing a partial/empty artifact.
- The script does NOT use `eval`, `bash -c`, or `sh -c` over variable content. Shell-eval safety is one of the defect classes the script mines — it must not contain the defect it finds.

## baseline-orientation-metrics.sh

Collects baseline metrics (PR count, drift violations, build archives) for orientation. Run at session start for a quick project pulse.
