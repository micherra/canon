---
title: Observability Domain
description: Choosing the right signal -- logs, metrics, or traces -- for the question being asked.
---

# Observability Domain

## Mental Models

**Three Signals, Different Questions** — Logs tell you what happened in a specific execution ("user 42 failed login"). Metrics tell you what is happening in aggregate ("login failure rate up 3x"). Traces tell you how a request flowed through the system ("slow because stage 3 called stage 5 twice"). Each signal answers questions the others can't; using the wrong signal for the question produces either alert storms or blind spots. Design instrumentation around the question each signal is meant to answer.

**Observability Is About Unknown Questions** — Monitoring checks for known-bad states. Observability lets you investigate states you didn't anticipate. The difference is high-cardinality context: can you filter by customer, by endpoint, by version, by feature flag, by request ID? If the only way to answer "what is different about the failing requests?" is to deploy new logging and wait, the system is monitored but not observable.

**Every Log Line Is a Tradeoff** — Logs are the easiest instrumentation and the most expensive at scale. An endpoint that logs every request fine at 10 QPS becomes a cost center at 10k QPS. Prefer structured events with sampling to verbose free-text logs. The signal-to-noise ratio of logs degrades with volume; aggressive pruning is almost always correct.

## Decision Frameworks

**Structured vs free-text** — Logs that will be queried at scale (customer X did Y) must be structured (JSON with stable keys). Logs that are only for a human reading a single file (startup banner, panic trace) can be free-text. The moment a log line becomes a query target, its format is a contract; changing it breaks dashboards and alerts.

**When to sample** — Sample high-volume, redundant signals (successful requests at steady state). Never sample errors, never sample rare events, never sample the first occurrence of a new value. Head sampling (decide at request start) is cheap but loses rare errors; tail sampling (decide at request end with full context) preserves errors but needs infrastructure.

**Alert design** — Alert on symptoms users feel (error rate, latency, unavailability), not on causes (CPU, memory). Cause-based alerts produce noise — a CPU spike is only meaningful if it turns into user pain. Every alert should have a runbook, a linked dashboard, and a clear "what to do in the first 5 minutes" action. Pages without actions become background noise.

## Failure Modes

**Log-level creep** — Everything becomes INFO because DEBUG is off in production and WARN "feels alarmist." Log levels stop distinguishing anything. Use levels as policy: ERROR pages someone, WARN is for humans to investigate, INFO is for context, DEBUG is for development only. If you can't say what action each level implies, the levels have lost their meaning.

**Cardinality explosion** — Adding `user_id` as a label to a Prometheus metric. Metrics systems are built for low-cardinality aggregation, not per-row lookup. The result is storage and query cost orders of magnitude higher than expected. Use logs or traces for high-cardinality attributes; reserve metric labels for small, bounded sets (HTTP status class, service name, environment).

**Dashboard graveyard** — Dashboards accumulate faster than they are retired. Half of them don't render because their queries broke after a metric rename. A dashboard that no one looks at during an incident is not helping; a dashboard that breaks silently is actively misleading. Treat dashboards like code: ownership, review, deletion when obsolete.

**Trace sampling that loses the bug** — Traces are sampled at 1% at ingest and the incident-causing request is never captured. The trace you needed is gone. Tail-sample on error conditions, keep all slow requests, and always emit the root span even when the subtree is sampled out. The request you need to debug is never the one you expected.

## Guardrails

**"Measure before optimizing" applies to instrumentation too** — You should add instrumentation where it helps. If you're adding metrics to every function, tracing every internal call, or logging every variable, you've gone too far. Instrument at system boundaries and decision points; interior code is observable through its boundary effects.

**Alert everywhere** — You should alert on user-visible pain. If every metric has an alert rule and every alert pages someone, you've created alert fatigue that makes real pages invisible. Alerts should be outnumbered by dashboards and runbooks; most metrics are for investigation, not notification.

**Structured logging reinvention** — You should use structured logs. If you're building your own logger with your own format, your own shipping, and your own parser, you've gone too far. Standard libraries (slog, zap, OpenTelemetry) cover the ground; the marginal feature of a custom logger almost never justifies the maintenance cost.

**Log-as-database** — You should query logs for investigation. If production queries against logs are the primary way to compute business metrics, you've chosen the wrong tool. Business-critical aggregates belong in metrics or a data warehouse; logs are for investigation, not for billing.
