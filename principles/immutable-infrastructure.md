---
id: immutable-infrastructure
title: Infrastructure Components Are Immutable After Deployment
severity: strong-opinion
scope:
  languages: []
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
