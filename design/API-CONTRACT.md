# API contract

All endpoints are JSON in / JSON out, served by the single Express process. Errors are always
`{"error": "<safe message>"}` with an appropriate status code — messages are sanitized
(`sk-…` masked, no stack traces, no telemetry content).

## GET /api/health

Liveness + dependency probe. Never returns the key itself.

```json
{
  "keyConfigured": true,
  "model": "z-ai/glm-5.3-flash",
  "tier": "Confidential TEE",
  "jaeger": "ok" | "unreachable",
  "prometheus": "ok" | "unreachable",
  "collector": "ok" | "unreachable"
}
```

## GET /api/scenarios

```json
[
  { "id": "payment-db-down", "severity": "SEV1", "service": "checkout",
    "summary": "checkout 500s — payment authorize timing out, payments-db refusing connections" }
]
```

## POST /api/seed  ·  body `{ "scenario": "payment-db-down", "windowMinutes": 30 }`

Emits the synthetic incident through the collector into Jaeger + Prometheus.

```json
{ "scenario": "payment-db-down", "severity": "SEV1", "suggestedService": "checkout",
  "windowMinutes": 30, "tracesPushed": 5, "metricPushes": 6 }
```

## POST /api/telemetry  ·  body `{ "service", "sinceMinutes", "maxTraces" }`

Fetches latest error data; **preview only, no model call.**

```json
{
  "service": "checkout",
  "sinceMinutes": 30,
  "window": { "from": "ISO", "to": "ISO" },
  "queries": {
    "jaeger": "http://…/api/traces?service=checkout&start=…&end=…&limit=20",
    "jaegerError": null,
    "prometheus": ["increase(http_requests_total{…}[35m])", "…"]
  },
  "traceCount": 5,
  "errorSpans": [
    { "traceID": "a1b2c3d4", "service": "checkout", "operation": "POST /api/checkout",
      "statusCode": 500, "route": "/api/checkout", "durationMs": 1930,
      "exceptionType": "java.net.ConnectTimeoutException",
      "exceptionMessage": "connect timed out calling payments:5432 after 3 attempts",
      "startMs": 1731330000000 }
  ],
  "metrics": [
    { "query": "increase(…)", "series": [ { "labels": { … }, "lastValue": 266 } ] }
  ]
}
```

Non-error spans are filtered out **in our code** (ADR-010): a span is an error span if
`error=true` or `otel.status_code=ERROR` or it carries an exception event.

## POST /api/triage  ·  two modes

**Query mode** — body `{ "service", "sinceMinutes", "maxTraces" }`
**Paste mode** — body `{ "bundle": "<raw text, max 60 000 chars>" }`

Both run the same triage core. Response:

```json
{
  "report": { "…report schema, see DATA-MODELS.md…": true },
  "rawText": "only present if the model did not return clean JSON",
  "telemetry": "query mode only — same shape as /api/telemetry",
  "privacy": {
    "tier": "Confidential TEE",
    "tierDetail": { "runsWhere": "NEAR's own GPUs", "private": "…" },
    "model": "z-ai/glm-5.3-flash",
    "responseId": "resp_…",
    "usage": { "prompt_tokens": 0, "completion_tokens": 0 },
    "modelMs": 8420,
    "attempts": 1,
    "attestation": null,
    "scope": "Only the model call is private: it ran inside a Confidential TEE. …"
  }
}
```

Failure modes:
- No key configured → `502 {"error":"NEARAI_API_KEY is not set — copy .env.example to .env"}`
- Telemetry unreachable (query mode) → `502` with both reasons
- Model call fails / times out (60 s) → `502` with status code only, no body echo
- Model returns non-JSON twice → `200` with `report: null` + `rawText` (UI shows raw reply)

## Logging policy (server-side, enforced in code review)

Each request logs exactly one JSON line: timestamp, route, mode, service, evidenceChars,
attempts, modelMs, totalMs, parsed. **Never** telemetry content, bundle text, model output, or the key.
