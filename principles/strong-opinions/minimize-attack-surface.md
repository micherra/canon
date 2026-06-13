---
id: minimize-attack-surface
title: Minimize the Attack Surface
severity: strong-opinion
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
    - "**/api/**"
    - "**/routes/**"
tags:
  - security
  - threat-modeling
  - api-design
---

Expose only what is necessary. Disable unused features, close unnecessary ports, remove debug endpoints from production, restrict CORS origins, and drop unnecessary package dependencies. Every exposed endpoint, open port, enabled feature, or included dependency increases the attack surface — more code to exploit, more configurations to misconfigure.

## Rationale

*Threat Modeling: Designing for Security* defines attack surface as the sum of all points where an attacker can interact with the system. Each exposed surface is a potential entry point. Reducing attack surface is the highest-leverage security measure because it eliminates entire categories of attacks rather than defending against them one by one.

The failure mode is incremental: a debug endpoint added during development (`/api/debug/users`), a Redis port exposed to the host network, a CORS policy set to `*` for convenience, a dependency added for one utility function. Each one is small. Together they create a broad, unmaintained attack surface. The most common breaches exploit surfaces that nobody realized were exposed.

## Examples

**Bad — unnecessarily broad exposure:**

```hcl
# Security group open to the world on all ports
resource "aws_security_group_rule" "allow_all" {
  type        = "ingress"
  from_port   = 0
  to_port     = 65535
  protocol    = "tcp"
  cidr_blocks = ["0.0.0.0/0"]
}
```

```yaml
# Docker Compose exposing database port to host
services:
  redis:
    image: redis:7
    ports:
      - "6379:6379"  # Accessible from host network
  postgres:
    image: postgres:16
    ports:
      - "5432:5432"  # Accessible from host network
```

```typescript
// Wildcard CORS in production
app.use(cors({ origin: "*" }));

// Debug endpoints left in production
app.get("/api/debug/users", async (req, res) => {
  const users = await db.user.findMany();
  res.json(users); // Dumps entire user table
});
```

**Good — minimal exposure:**

```hcl
# Security group allows only HTTPS from the load balancer
resource "aws_security_group_rule" "allow_https" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb.id
}
```

```yaml
# Database only accessible within Docker network
services:
  redis:
    image: redis:7
    expose:
      - "6379"  # Internal only, not mapped to host
```

```typescript
// CORS restricted to known origins
app.use(cors({
  origin: ["https://app.example.com", "https://admin.example.com"],
}));

// Debug endpoints gated behind feature flag and auth
if (config.enableDebugEndpoints) {
  app.get("/api/debug/users", requireAdmin, async (req, res) => { ... });
}
```

## Exceptions

Development environments may have broader access for convenience (exposing database ports for local tools, wildcard CORS for local frontends). Public APIs intentionally expose endpoints — but even then, unused endpoints should be removed and rate limiting applied. Monitoring and health check endpoints need to be accessible but should not expose sensitive data.

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
