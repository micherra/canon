# Error Handling Domain

## Mental Models

**Errors Are Values, Not Emergencies** — An error is a specific program state, not an exception to normal flow. Treating errors as emergencies (throw-and-hope, global handlers, top-level catches that log and return 500) abandons the type system's ability to express "this can fail." Treating errors as values — explicit return types, discriminated unions, pattern matching — puts the failure cases in the same place the compiler checks them. Code that can't compile-time-prove it handled every error case probably didn't.

**Three Causes, Three Responses** — A failure is either a bug (our code is wrong, the fix is to change code), a misuse (the caller sent something invalid, the fix is to reject with a clear message), or an environmental condition (the network is down, the DB is overloaded, the fix is to retry or fall back). Conflating these produces the worst error handling: retrying a bug forever, crashing on misuse, returning a generic 500 for environmental issues. Categorize the error before deciding how to handle it.

**Error Messages Are For Future You** — The error you're writing will be read six months later by someone investigating an incident at 3am. The message needs to answer: what operation failed, what inputs were involved (sanitized), and what the specific cause was. "Database error" tells the reader nothing. "Failed to insert user {id} into users table: duplicate key on email" is a runbook entry.

## Decision Frameworks

**Retry vs fail fast** — Retry when the failure is transient and idempotent (network blip on a GET, rate limit). Fail fast when the failure is deterministic (invalid input, permission denied) or non-idempotent without idempotency keys (POST without dedup). The default should be fail fast; retries are a specific opt-in for known-transient operations. A blanket "retry everything 3 times" hides real bugs and amplifies outages.

**Circuit breaker placement** — Wrap dependencies that can fail in patterns we can't serve through (the auth service, the payments gateway). Do not wrap internal calls within the same service — breaker state becomes a confusing coupling. Breaker state must be observable: an alert when a breaker opens tells you "we've decided X is down," which is different from "X is down."

**Error propagation vs translation** — Propagate errors unchanged across layers that share a trust boundary (internal service calls within one domain). Translate at boundaries where the caller shouldn't know about the inner error (do not return a DB error to a public API consumer). The translation layer is where you sanitize: scrub secrets, generalize internal paths, map to the caller's error taxonomy.

## Failure Modes

**The silent swallow** — `catch { }` or `except: pass`. An error happens, nothing is logged, the program continues as if nothing did. Six months later, someone investigates why data is missing and traces it to this block. If you're catching an error, you must do one of: log it with enough context to debug, handle it with a specific response, or re-raise. "Ignore it" is a choice that should require a comment explaining why.

**Error type proliferation** — Creating a unique error class for every possible failure mode. A service with fifty distinct error types cannot be consumed usefully; every caller has to decide how to handle fifty cases. Group errors into categories (client error, server fault, transient, not found) that correspond to caller actions. Specific subtypes exist for cases where the action differs.

**Retry amplification** — A downstream is slow, the caller retries 3x, that caller's caller also retries 3x, and each retry hits a slower system until it collapses. The retry storm is the outage. Budget retries at the outermost layer; inner layers should fail fast and let the budget holder decide.

**Exception-as-control-flow** — Raising exceptions to signal non-error conditions (record not found, user not logged in, feature disabled). The stack-unwinding cost and the confusion between expected and unexpected states both bite. Use return values or Option/Result types for expected outcomes; reserve exceptions for genuine unexpected failures.

## Guardrails

**Error-handling coverage theater** — You should handle errors. If every function has a try/catch at the top that logs and re-throws the same error, you've added noise without adding behavior. Handle errors where you can respond to them; let the rest propagate.

**Retry everywhere** — You should retry transient failures. If every call to every dependency is wrapped in a retry loop "just in case," you've made the system slower without making it more reliable. Retry explicitly, with a budget, and only where the failure is known to be transient.

**Stringly-typed errors** — You should have error classifications. If you're matching on error message strings ("if msg contains 'not found'"), you've turned the error message — which was meant for humans — into a contract. Use error codes or error types; keep messages free to change.

**Errors that leak internals** — You should report errors usefully. If the error response to an end user includes a stack trace, a SQL query, or an internal file path, you've leaked. Internal errors are sanitized at the boundary into error codes + correlation IDs the support team can cross-reference to the real trace in logs.
