---
id: design-for-self-healing
title: Design for Automatic Recovery
severity: convention
portable: true
scope:
  layers: []
  file_patterns:
    - "**/*.tf"
    - "**/*.tfvars"
    - "**/terraform/**"
    - "**/Dockerfile*"
    - "**/docker-compose*"
    - "**/k8s/**"
    - "**/kubernetes/**"
    - "**/helm/**"
    - "**/infra/**"
    - "**/infrastructure/**"
    - "**/deploy/**"
    - "**/deployment/**"
    - "**/.github/**"
    - "**/services/**"
    - "**/api/**"
tags:
  - infrastructure
  - cloud-native
  - reliability
---

Deployments must include mechanisms for automatic recovery: health check endpoints, readiness and liveness probes, restart policies, and circuit breakers. Systems should recover from transient failures without human intervention. If a service crashes at 3 AM, it should restart itself — not wait for someone to notice.

## Rationale

*Cloud Native Infrastructure* emphasizes that cloud environments have transient failures by design. Instances get terminated for maintenance, networks partition momentarily, dependencies restart during deployments. Systems that require human intervention for recovery have incident response times measured in minutes or hours. Self-healing systems recover in seconds.

The failure mode: a service runs without health checks or restart policies. It encounters an out-of-memory error at 2 AM and stays down until the on-call engineer is paged, wakes up, diagnoses the problem, and manually restarts it. With a restart policy and a health check, the container orchestrator would have restarted it automatically within seconds.

## Examples

**Bad — no self-healing mechanisms:**

```yaml
# K8s deployment with no probes or restart policy
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: myapp:latest
          # No liveness probe — K8s can't detect if app is hung
          # No readiness probe — traffic routes to unready pods
          # No resource limits — OOM can affect other pods
```

```typescript
// Service with no health check endpoint
const app = express();
app.get("/api/users", userHandler);
app.listen(3000);
// No /health or /ready endpoint for orchestrator to check
```

**Good — self-healing mechanisms in place:**

```yaml
# K8s deployment with health probes and resource management
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: myapp:v1.2.3
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            limits:
              memory: "512Mi"
              cpu: "500m"
      restartPolicy: Always
```

```typescript
// Health and readiness endpoints
app.get("/health", (req, res) => {
  // Liveness: is the process alive and not deadlocked?
  res.status(200).json({ status: "ok" });
});

app.get("/ready", async (req, res) => {
  // Readiness: can this instance handle traffic?
  const dbOk = await checkDatabaseConnection();
  const cacheOk = await checkRedisConnection();
  if (dbOk && cacheOk) {
    res.status(200).json({ status: "ready" });
  } else {
    res.status(503).json({ status: "not ready", db: dbOk, cache: cacheOk });
  }
});
```

## Exceptions

Batch jobs and one-shot tasks that are designed to run once and terminate should not automatically restart on failure — restarting a failed batch job may cause duplicate processing. These should have alerting on failure and idempotent retry mechanisms instead. Local development environments where immediate feedback from crashes is more useful than automatic restart.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "This principle is too strict for this case." | Principles prevent common failure modes specifically in edge cases and delivery pressure, where shortcuts look most attractive. | Apply the principle unless a concrete, bounded exception is documented under `## Exceptions`. |
| "We'll clean it up after this ships." | Deferred quality work usually becomes permanent debt and normalizes repeated violations. | Implement the compliant approach now, or record an explicit follow-up with owner and due date. |
| "Code review can catch this later." | Manual review is inconsistent under time pressure and cannot replace explicit constraints. | Encode compliance in code structure, tests, or linting so violations fail fast and repeatably. |
| "This is just a small change, so the rule doesn't matter." | Small changes accumulate into systemic drift when principles are waived incrementally. | Hold small changes to the same bar and verify the invariant still holds after each change. |

## Verification

- [ ] Updated files satisfy this principle's core constraint in behavior and structure.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.
- [ ] Tests, lints, or checks were added/updated where needed so regressions are detectable.
