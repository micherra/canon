---
id: least-privilege-access
title: Grant Only the Minimum Access Required
severity: rule
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

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "Admin access is easier during development — I'll restrict it before prod." | Dev permissions routinely follow the service to staging and then production. The cost of restricting permissions late is higher (more testing, possible breakage) than doing it right initially. | Define the minimum permission set first. Test with restricted permissions from the start. |
| "We're already behind authentication — the service is protected." | Auth confirms identity; it doesn't limit what a compromised or misbehaving identity can do. A single compromised credential with `*` access is a full account breach. | Defense in depth: auth tells you who; permissions limit what. Both are required. |
| "It's just one wildcard — the resource ARN is specific." | `Action: "*"` on a specific resource still grants every current and future action on that resource, including destructive ones you didn't intend (DeleteBucket, PutBucketPolicy, etc.). | Enumerate the specific actions the service needs. Use `s3:GetObject` not `s3:*`. |
| "The IAM policy is complex to scope properly right now." | Complexity is not an exception to least privilege. A temporary broad permission becomes a permanent security debt. | Scope to the actions you understand now. Expand incrementally as specific needs are confirmed. |

## Verification

- [ ] No wildcard actions in production IAM policies — grep for `"Action": "*"` and `Action = "*"` in Terraform and CloudFormation files under `infra/` or `deploy/`.
- [ ] No wildcard resources paired with sensitive actions — grep for `"Resource": "*"` and confirm that any matches are paired only with read-only or explicitly scoped actions.
- [ ] No `cluster-admin` ClusterRoleBindings for application service accounts — grep for `name: cluster-admin` in Kubernetes RBAC files and confirm each binding is for an infrastructure-level service, not an application service account.
