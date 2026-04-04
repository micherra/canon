# Backend API Domain

Pay attention to these concerns when working in this domain.

- **Request validation**: Validate and sanitize all incoming data at the boundary before it reaches business logic.
- **Error response format**: Return consistent error shapes (status, code, message) across all endpoints so clients can handle errors uniformly.
- **Authentication and authorization**: Check identity and permissions on every protected route; never trust client-supplied identity claims without verification.
- **Rate limiting**: Apply rate limits and request size caps to prevent abuse and resource exhaustion.
- **HTTP status codes**: Use semantically correct status codes (400 for bad input, 401 for unauthenticated, 403 for forbidden, 404 for not found, 409 for conflict, 500 for server fault).
- **API versioning**: Consider how changes will affect existing clients; prefer additive changes and version breaking changes.
- **Idempotency**: Mutating operations (POST, PUT, PATCH, DELETE) should be safe to retry; use idempotency keys where appropriate.
