---
id: secrets-never-in-code
title: Secrets Must Never Appear in Source Code
severity: rule
scope:
  languages: []
  layers: []
tags:
  - security
  - cloud-security
  - credentials
---

Source files must never contain hardcoded secrets: API keys, passwords, tokens, connection strings with credentials, private keys, or encryption keys. Secrets must come from environment variables, secret managers (AWS Secrets Manager, HashiCorp Vault, etc.), or encrypted configuration. There is no legitimate scenario for production secrets in source files.

## Rationale

Hardcoded secrets in source code get committed to version control, copied into logs, exposed in error messages, and leaked through repository forks. Once a secret is in git history, it is compromised — even if deleted in a later commit, it remains in the history. *Practical Cloud Security* identifies credential leakage as one of the most common and damaging security failures in cloud environments.

This is `rule` severity because the risk is absolute: a single leaked credential can compromise an entire system, and there is no valid use case for production secrets in source code. The fix is always the same: externalize the secret.

AI-generated code frequently includes placeholder secrets that look like real ones (`sk-live-abc123...`), or copies connection strings from documentation that include credentials. These patterns train developers to accept secrets in code as normal.

## Examples

**Bad — secrets hardcoded in source files:**

```typescript
// API key directly in source
const STRIPE_KEY = "sk_live_EXAMPLE_REPLACE_ME_1234567890";
const DATABASE_URL = "postgres://admin:s3cur3Pa$$@prod-db.example.com:5432/app";

// Even in config files committed to git
export default {
  jwt: { secret: "my-jwt-secret-key-2024" },
  aws: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXU..." },
};
```

```yaml
# docker-compose.yml with real credentials
services:
  app:
    environment:
      - DB_PASSWORD=realProductionPassword123
      - API_SECRET=sk-prod-abc123def456
```

**Good — secrets externalized:**

```typescript
// Read from environment variables with validation
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY) throw new Error("STRIPE_SECRET_KEY environment variable is required");

// Or use a secret manager
const dbPassword = await secretManager.getSecret("prod/database/password");
const connectionString = `postgres://${user}:${dbPassword}@${host}:${port}/${db}`;
```

```yaml
# docker-compose.yml referencing external secrets
services:
  app:
    environment:
      - DB_PASSWORD=${DB_PASSWORD}  # Set in .env (gitignored) or CI/CD
    secrets:
      - api_secret
secrets:
  api_secret:
    external: true
```

## Exceptions

Test fixtures using obviously fake values (`"test-api-key"`, `"password123"`, `"sk_test_..."`) are exempt — these are not real secrets. Example configuration files with placeholder values (`"YOUR_API_KEY_HERE"`, `"changeme"`) are acceptable. Public keys (designed to be shared) are not secrets. `.env.example` files with placeholder values are acceptable; `.env` files with real values must be gitignored.

**Related:** `externalize-configuration` addresses the same solution (environment variables, config stores) but for a different reason — deployment flexibility rather than security. A hardcoded `API_URL = "https://api.prod.example.com"` violates externalize-configuration but not this principle (no secret). A hardcoded `DATABASE_URL = "postgres://admin:password@host/db"` violates both.
