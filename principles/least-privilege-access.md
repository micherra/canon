---
id: least-privilege-access
title: Grant Only the Minimum Access Required
severity: rule
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
  - security
  - cloud-security
  - permissions
---

Code granting permissions must request only the minimum access required for its specific function. Every permission beyond the minimum needs documented justification. Wildcard permissions (`Action: "*"` or `Resource: "*"`) are always violations unless scoped to a specific, limited resource set.

## Rationale

Overly broad permissions are the most common cloud security misconfiguration. An IAM policy with `Action: "*"` turns a single compromised credential into full account access. *Practical Cloud Security* emphasizes that permissions should be granted based on the principle of least privilege — each identity should have exactly the permissions it needs and no more.

The failure mode is predictable: a developer adds broad permissions "to get it working" and never narrows them. Six months later, a leaked credential or compromised service has far more access than it should. In cloud environments, over-permissioned identities are the primary vector for privilege escalation attacks.

AI-generated infrastructure code frequently defaults to wildcard permissions because training data contains copy-pasted examples with overly broad access. The LLM reaches for `"*"` because it always works, not because it's safe.

## Examples

**Bad — wildcard permissions granting full access:**

```hcl
# Terraform IAM policy — grants full S3 access to a service
# that only needs to read from one bucket
resource "aws_iam_policy" "app_policy" {
  name = "app-s3-access"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "s3:*"
      Resource = "*"
    }]
  })
}
```

```yaml
# K8s RBAC — cluster-admin for a service that only reads pods
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: app-binding
roleRef:
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: app-service
```

**Good — scoped permissions with documented justification:**

```hcl
# Grants only GetObject on the specific bucket this service reads from
resource "aws_iam_policy" "app_policy" {
  name        = "app-s3-read-uploads"
  description = "Read access to upload bucket for image processing service"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "arn:aws:s3:::myapp-uploads/*"
    }]
  })
}
```

```yaml
# Custom role with only the verbs and resources the service needs
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
```

## Exceptions

Emergency break-glass roles used for incident response may have broader permissions, but must be time-limited (session-based), audit-logged, and require explicit approval to assume. Development and sandbox environments may use broader permissions for experimentation, but production infrastructure must follow least privilege strictly.
