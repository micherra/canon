---
id: immutable-infrastructure
title: Infrastructure Components Are Immutable After Deployment
severity: strong-opinion
scope:
  layers:
    - infra
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
tags:
  - infrastructure
  - iac
  - deployment
---

Infrastructure components — servers, containers, VM images — must not be modified after deployment. Configuration changes require building new artifacts and redeploying. No SSH into servers to fix things, no runtime patches, no manual configuration edits on running instances. If you need to change it, rebuild and replace it.

## Rationale

*Infrastructure as Code* identifies configuration drift as the root cause of "works on my machine" at the infrastructure level. When servers are modified in place, they diverge from what the code describes — becoming unique, unreproducible snowflakes. The next deploy may overwrite the manual fix, or worse, the manual fix becomes load-bearing and nobody knows it exists.

Immutable infrastructure guarantees reproducibility: the running system is exactly what the code describes, because the only way to change it is to change the code and redeploy. This makes rollbacks trivial (deploy the previous artifact), scaling reliable (new instances are identical), and debugging tractable (the artifact you're debugging is the artifact that's running).

The failure mode: someone SSHs into a production server to fix an urgent issue, the fix works, nobody updates the IaC, and the next deploy reverts the fix. Now the "fixed" server and the "deployed" servers behave differently.

## Examples

**Bad — mutable infrastructure patterns:**

```yaml
# CI step that modifies a running server
- name: Fix nginx config
  run: |
    ssh prod-server "sudo sed -i 's/worker_connections 1024/worker_connections 4096/' /etc/nginx/nginx.conf"
    ssh prod-server "sudo systemctl restart nginx"
```

```dockerfile
# Dockerfile that updates packages at runtime
FROM ubuntu:22.04
CMD apt-get update && apt-get install -y curl && ./start.sh
# Every container starts with different package versions
```

**Good — immutable infrastructure patterns:**

```dockerfile
# All dependencies baked into the image at build time
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
# Every instance runs the exact same artifact
```

```hcl
# Terraform replaces instances on config change
resource "aws_launch_template" "app" {
  image_id = data.aws_ami.app.id  # New AMI = new instances
  lifecycle {
    create_before_destroy = true  # Blue-green replacement
  }
}
```

## Exceptions

Stateful systems — databases, persistent volumes, message broker data — cannot be trivially replaced. The principle applies to compute and configuration, not to data. Emergency hotfixes may require runtime changes to stop active incidents, but must be followed immediately by a proper rebuild and redeploy that incorporates the fix into the code.

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
