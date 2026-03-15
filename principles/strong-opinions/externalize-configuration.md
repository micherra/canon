---
id: externalize-configuration
title: Externalize Environment-Specific Configuration
severity: strong-opinion
scope:
  layers:
    - api
    - domain
    - infra
tags:
  - infrastructure
  - configuration
  - cloud-native
---

Environment-specific values — URLs, hostnames, ports, feature flags, timeouts, connection pool sizes — must not be hardcoded in source files. They must come from environment variables, config maps, parameter stores, or configuration files that vary per environment. The same code artifact should deploy to development, staging, and production without modification.

## Rationale

*Cloud Native Infrastructure* and *Infrastructure as Code* both emphasize the twelve-factor app principle: configuration that varies between environments belongs in the environment, not in the code. Hardcoded environment values mean either building different artifacts per environment (unreliable — you're not testing what you're deploying) or maintaining if/else blocks for each environment (fragile — every new environment requires code changes).

The failure mode: `const API_URL = "https://api.prod.example.com"` works until you need a staging environment. Then someone adds `if (process.env.NODE_ENV === "staging")`, and now every new environment requires a code change. Distinct from `secrets-never-in-code` (which is about security); this principle is about deployment flexibility and artifact immutability.

## Examples

**Bad — hardcoded environment values:**

```typescript
// Hardcoded URLs and configuration
const API_URL = "https://api.prod.example.com";
const REDIS_HOST = "redis.internal.prod";
const MAX_RETRIES = 3;
const FEATURE_NEW_CHECKOUT = true;

// Environment if/else chains
const dbHost = process.env.NODE_ENV === "production"
  ? "prod-db.example.com"
  : process.env.NODE_ENV === "staging"
  ? "staging-db.example.com"
  : "localhost";
```

**Good — configuration externalized:**

```typescript
// All environment-specific values from external configuration
import { z } from "zod";

const ConfigSchema = z.object({
  API_URL: z.string().url(),
  REDIS_HOST: z.string(),
  MAX_RETRIES: z.coerce.number().int().positive().default(3),
  FEATURE_NEW_CHECKOUT: z.coerce.boolean().default(false),
});

export const config = ConfigSchema.parse(process.env);
```

```yaml
# K8s ConfigMap provides environment-specific values
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  API_URL: "https://api.staging.example.com"
  REDIS_HOST: "redis.staging.internal"
  MAX_RETRIES: "5"
```

## Exceptions

Truly universal constants — mathematical constants, protocol-defined values, RFC-specified limits, HTTP status codes — are not environment configuration and may be hardcoded. Default values that are genuinely reasonable across all environments (e.g., a default page size of 20) are acceptable as code defaults with environment override capability. The test: "Would this value ever differ between development, staging, and production?"

**Related:** `secrets-never-in-code` addresses the same solution (environment variables, secret stores) but for a security reason — leaked credentials compromise systems. This principle is about deployment flexibility — hardcoded URLs prevent multi-environment deploys. A connection string with a password violates both; a hardcoded timeout value violates only this one.
