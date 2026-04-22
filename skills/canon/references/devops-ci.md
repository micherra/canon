# DevOps & CI/CD Domain

## Mental Models

**The Pipeline Is A Program** — CI/CD pipelines grow like organic code: steps added one by one, rarely refactored. Treat them like source code — version-controlled, reviewed, tested, and refactored when they sprawl. A pipeline that no one owns is the pipeline that fails on Friday and nobody can debug. If the yaml is 1,000 lines, you have a program; reason about it like one.

**Environment Parity Or Pain** — The difference between dev and production is where surprises live. "Works on my machine, fails in CI, passes in staging, breaks in prod" is a statement about environment drift, not about the code. Invest in making environments similar (same container images, same OS, same services, same config shape). The parity doesn't have to be perfect, but the places it is not perfect must be known and documented.

**Fast Feedback Is The Only Feedback** — A CI run that takes 30 minutes is a CI run engineers stop watching. They context-switch, they forget why they pushed, they merge before it finishes. A 5-minute pipeline gets eyeballs; a 30-minute pipeline gets bypassed. Pipeline time is a feature, not an infrastructure detail. Every minute of CI is a minute every engineer pays.

## Decision Frameworks

**Pipeline stage ordering** — Cheap fast checks first (lint, typecheck, unit tests). Expensive slow checks last (integration, e2e). Fail fast on the cheap checks so expensive infrastructure isn't consumed on PRs that won't compile. Parallelize stages that don't depend on each other; a serial pipeline is wasting the CI grid.

**Build optimization priorities** — Cache dependencies (package manager caches, container layer caches); the cold install is most of the time. Use incremental builds where possible (tsc --build, bazel, turborepo). Run tests in parallel when tests are independent; serialize only when shared state requires it. Ship the build artifact, not the source tree: downstream stages should not recompile.

**Deploy strategy selection** — Blue/green for services where instant rollback matters and you can afford double capacity during cutover. Rolling for services where gradual exposure is acceptable and double capacity is too expensive. Canary when you need to validate a change with real traffic before full exposure. Big-bang deploys ("just push it") are acceptable for tiny systems or scripts, not for anything with users.

## Failure Modes

**Pet snowflake runners** — The build agent has `curl` installed that nobody else does, an out-of-date SSL cert that nobody rotates, and a `~/.ssh/config` that was last touched in 2019. When that machine dies, the build dies with it. Runners should be stateless (fresh container or image per run) or fully provisioned via code (IaC). "Log into the runner and fix it" is a smell.

**Secrets in logs** — An env var gets echoed by the shell, a debug print dumps a request headers object, a test fixture contains a real API key. CI logs are retained, shared, and often accessible to more people than production. Treat logs as a public channel: redact aggressively, prefer structured secrets injection, review log output for leaks periodically.

**Green-ness as theater** — The pipeline passes because tests were disabled, because the lint rule was loosened, because `continue-on-error: true` was added "temporarily." Green CI is only useful when green means "the checks we care about actually ran and passed." Audit disabled tests and skipped stages; they accumulate.

**Manual deploy drift** — The production config has things the repo doesn't, because someone `kubectl edit`'d during an incident and nobody updated the source. The next clean deploy reverts the fix. Either manual changes should be actively prevented (immutable infrastructure, RBAC), or they must be immediately codified back into source. Tolerating drift is choosing to keep relearning the same lesson.

## Guardrails

**Pipeline sprawl** — You should have a thorough CI pipeline. If you have twelve parallel matrix jobs and nine of them duplicate what the other three cover, you've added cost without adding signal. Every check should exist because you've seen the class of bug it catches; remove checks that have not caught anything in a year of runs.

**Flaky test tolerance** — You should retry on known-flaky conditions. If your pipeline retries every test automatically three times and you've stopped looking at which ones are flaky, you've normalized deviance. Flaky tests are bugs; fix them or quarantine them, don't mask them.

**Reinvention of orchestration** — You should automate deploys. If you're writing custom orchestration scripts that replicate what Kubernetes, Terraform, or your CI platform already does, you've gone off the paved road. Accept the opinions of the tooling you're already using; bespoke orchestration is a long-term cost.

**Environment-specific hacks** — You should handle environment differences. If production has a codepath branch that dev doesn't ("if env == 'prod': do_the_real_thing"), you've guaranteed the dev version is untested in practice. Environment-specific config (credentials, URLs) is fine; environment-specific logic is a smell that usually means "staging doesn't test what we deploy."
