---
id: design-for-self-healing
title: Design for Automatic Recovery
severity: convention
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
