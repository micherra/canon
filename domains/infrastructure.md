# Infrastructure Domain

Pay attention to these concerns when working in this domain.

- **Configuration management**: Store all configuration in environment variables or a secrets manager; never hard-code credentials or environment-specific values.
- **Resource limits**: Set CPU, memory, and connection pool limits on all services; document expected steady-state and burst usage.
- **Health checks**: Expose a health endpoint for every long-running service; ensure load balancers and orchestrators use it.
- **Logging and observability**: Emit structured logs with a consistent schema; include trace IDs so requests can be followed across services.
- **Network security**: Enforce TLS on all external endpoints; apply least-privilege firewall rules; never expose internal services to the public internet.
- **Deployment rollback**: Ensure every deployment can be rolled back within minutes; keep the previous artifact available until the new one is proven stable.
- **Dependency pinning**: Pin dependency versions in lockfiles and base images; use a renovate/dependabot policy rather than floating tags.
