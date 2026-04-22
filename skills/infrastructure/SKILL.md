---
name: infrastructure
description: Domain primer for deployment, configuration, and environment management. Covers idempotency-vs-imperativeness, secret hygiene, environment parity, and the "one more environment variable" anti-pattern. Use when writing Dockerfiles, CI/CD config, deployment scripts, IaC (Terraform/Pulumi), or reviewing release pipelines.
user-invocable: false
---

# Infrastructure Domain

## Mental Models

**Infrastructure Is Code You Can't Rollback Easily** — A bad code deploy can be reverted in seconds. A bad infrastructure change (deleted DNS record, dropped database, misconfigured security group) can take hours to recover from and may involve data loss. The blast radius of infrastructure mistakes is wider and the recovery time is longer than application code. This asymmetry should drive every decision about how carefully changes are tested and reviewed.

**Cattle, Not Pets** — Individual infrastructure components (servers, containers, pods) should be identical and replaceable. When one fails, you replace it, not repair it. The moment you SSH into a running server to fix something, that server has become a pet — it has unique state that isn't captured anywhere, and losing it means losing knowledge. Everything about the system's state should be captured in version-controlled configuration.

**Failure Is a Feature** — In distributed systems, components will fail. The question isn't whether a node will go down, a network partition will happen, or a deployment will break — it's whether the system's design accommodates these events gracefully. Health checks, circuit breakers, retry budgets, and graceful degradation aren't defensive extras — they're core infrastructure requirements.

## Decision Frameworks

**What to containerize** — Containerize applications with dependencies that differ from the host or from each other (language runtimes, native libraries, system tools). Don't containerize simple scripts or tools that run fine on the host with no dependency conflicts. The value of containers is reproducibility and isolation — if neither is a problem, the container adds build complexity and indirection without benefit.

**Managed vs. self-hosted** — Default to managed services (RDS over self-run Postgres, managed Kubernetes over kubeadm) unless you have a specific constraint: cost at scale, compliance requirements that prohibit shared infrastructure, or performance needs that managed services can't meet. The operational cost of self-hosting is almost always higher than it looks — patching, monitoring, backup, failover, capacity planning all become your responsibility.

**Environment parity** — Production, staging, and development should differ only in scale and data, not in architecture. A staging environment that uses SQLite while production uses Postgres, or that skips the CDN layer, or that runs without the message queue will not catch the failures that matter. The closer environments match, the more confidence deploys carry. Parity has diminishing returns — matching exact instance sizes is unnecessary, but matching the topology is critical.

## Failure Modes

**Configuration drift** — Making manual changes to running infrastructure (ad-hoc security group rules, manually installed packages, tweaked environment variables) that aren't captured in the infrastructure code. The running system and the code diverge. The next deploy from code either reverts the fix (breaking things again) or conflicts with the manual change (breaking things differently).

**Alert fatigue** — Setting alerting thresholds too low or alerting on metrics that don't require action. When every minor fluctuation pages someone, the team stops responding to alerts. The result is that real incidents are missed because they look like noise. Every alert should have a clear action: if the response to an alert is "check it and it's fine," the threshold is wrong.

**The golden image trap** — Building a single base image with everything pre-installed (runtime, dependencies, monitoring agents, debug tools) and using it for all services. The image becomes huge, slow to build, and any update requires rebuilding and redeploying everything. Prefer minimal base images with service-specific layers — shared concerns go in a thin base, service-specific dependencies go in the service image.

**Monitoring the infrastructure, not the user experience** — CPU is at 30%, memory is fine, all pods are running, but users can't load the page because a downstream API is timing out. Infrastructure metrics tell you the system is alive, not that it's working. Synthetic checks and user-facing metrics (response time, error rate, completion rate) tell you what users experience.

## Guardrails

**Infrastructure-as-code absolutism** — You should define infrastructure in code. If you're writing Terraform for a one-off developer tool, or managing a personal dev database through IaC, you've gone too far. IaC's value scales with the number of environments, the frequency of changes, and the consequence of misconfiguration. A shared production database needs IaC. A local dev script doesn't.

**Observability excess** — You should instrument your systems. If every function call emits a trace span, every variable change logs a debug line, and you're storing terabytes of telemetry you never query, you've gone too far. Instrument at service boundaries, business-critical operations, and known failure points. Observability costs storage, bandwidth, and cognitive load.

**Resilience theater** — You should design for failure. If you're running chaos engineering experiments on a system with three users, or building multi-region failover for an internal tool, you've gone too far. Resilience investment should be proportional to the blast radius and cost of downtime. A user-facing payment system needs circuit breakers. A weekly batch report doesn't.

**Environment multiplication** — You should have environment parity. If you're maintaining five environments (dev, staging, QA, pre-prod, prod) with separate infrastructure stacks, deployment pipelines, and configuration, you've gone too far. Each environment is operational overhead. Most teams need local development, one pre-production environment, and production. Add more only when you have a concrete reason.
