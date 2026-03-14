---
id: infrastructure-tested-like-code
title: Validate Infrastructure Definitions Before Deployment
severity: convention
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
  - testing
  - iac
---

Infrastructure definitions must be validated before deployment: linted, format-checked, plan-verified, and policy-tested. Untested infrastructure code is as dangerous as untested application code — more so, because infrastructure failures can take down entire systems, not just features.

## Rationale

*Infrastructure as Code* dedicates an entire chapter to testing infrastructure. Application code has decades of testing culture — linters, unit tests, integration tests, CI/CD gates. Infrastructure code often gets none of this: a Terraform change is reviewed by eye and applied directly to production. The consequences of an infrastructure bug are typically much larger than an application bug: a misconfigured security group exposes the entire network; a Terraform plan that destroys and recreates a database loses all data.

The failure mode: a Terraform change passes `terraform validate` (syntax check) but the `plan` shows it's destroying and recreating a production RDS instance. Nobody ran `plan` before applying. Or: a Dockerfile builds successfully but the image has a known vulnerability in its base layer that a scanner would have caught.

## Examples

**Bad — infrastructure code deployed without validation:**

```yaml
# CI pipeline that applies without validation
deploy:
  script:
    - terraform init
    - terraform apply -auto-approve  # No plan, no review, no policy check
```

```yaml
# Dockerfile never linted or scanned
build:
  script:
    - docker build -t myapp .
    - docker push myapp:latest  # No vulnerability scan, no lint
```

**Good — infrastructure validated in CI pipeline:**

```yaml
# CI pipeline with comprehensive validation
validate-infra:
  script:
    - terraform fmt -check -recursive
    - terraform init -backend=false
    - terraform validate
    - terraform plan -out=plan.tfplan
    - conftest test plan.tfplan  # OPA policy checks
  artifacts:
    paths: [plan.tfplan]

deploy-infra:
  needs: [validate-infra]
  when: manual  # Human approval after reviewing plan
  script:
    - terraform apply plan.tfplan  # Apply the exact reviewed plan

build-image:
  script:
    - hadolint Dockerfile
    - docker build -t myapp:$CI_SHA .
    - trivy image myapp:$CI_SHA  # Vulnerability scan
    - docker push myapp:$CI_SHA
```

## Exceptions

Local development environments where infrastructure is ephemeral and easily recreated (e.g., `docker-compose up` for a local dev stack). Sandbox/playground accounts used for experimentation where failures are expected and have no production impact.
