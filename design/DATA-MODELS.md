# Data models

## 1 · Evidence object (input to the TEE model)

Compact, capped, and the *only* thing that leaves the machine toward the model.

```jsonc
{
  "mode": "telemetry",            // or "paste"
  "window": {
    "service": "checkout",
    "minutes": 30,
    "from": "2026-11-11T16:00:00Z",
    "to":   "2026-11-11T16:30:00Z"
  },
  "errorTraces": 5,               // traces matched in the window
  "traces": [                     // top 8 traces, top 8 spans each
    {
      "services": ["checkout", "payment"],
      "spans": [
        { "service": "checkout", "operation": "POST /api/checkout",
          "route": "/api/checkout", "statusCode": 500, "durationMs": 1930,
          "exception": { "type": "java.net.ConnectTimeoutException",
                         "message": "connect timed out calling payments:5432 after 3 attempts" } }
      ]
    }
  ],
  "metrics": [                    // non-empty series only
    { "query": "increase(http_requests_total{service=\"checkout\",status=~\"5..\"}[35m])",
      "series": [ { "labels": { "service": "checkout", "status": "500", "route": "/api/checkout" },
                    "value": 266 } ] }
  ]
}
```

Paste mode: `{ "mode": "paste", "incidentBundle": "<≤60 000 chars>" }`.

Caps: 8 traces × 8 spans, 6 series per query, evidence JSON ≤ ~12 KB (guard: trim spans before the call).

## 2 · Report schema (model output — strict JSON)

```jsonc
{
  "rootCause":  { "summary": "…1–2 sentences citing concrete artifacts…",
                  "confidence": 0.0,              // 0–1
                  "evidence": ["span/exception/metric quotes"] },
  "alternates": [ { "summary": "…", "whyLessLikely": "…" } ],
  "blastRadius": { "services": ["checkout", "payment"], "summary": "…" },
  "nextActions": [ { "priority": 1, "action": "…", "command": "kubectl … | null", "why": "…" } ],
  "followUps":  ["…"],
  "severity":   "SEV1" | "SEV2" | "SEV3"
}
```

Validation: `rootCause.summary` is a string → accepted. Otherwise one retry-nudge
("return ONLY the JSON object"), then raw-text fallback.

## 3 · Seed scenario spec (internal)

```jsonc
{
  "id": "payment-db-down", "severity": "SEV1", "service": "checkout",
  "traceCount": 5, "windowMinutes": 30,
  "tree": { "service": "checkout", "name": "POST /api/checkout", "kind": "server",
            "durationMs": 1930, "error": true,
            "exception": { "type": "…", "message": "…" },
            "attrs": { "http.route": "/api/checkout", "http.status_code": 500 },
            "children": [ /* deeper services in the same trace */ ] },
  "metrics": [ { "name": "http_requests_total", "type": "counter",
                 "labels": { "service": "checkout", "status": "500", "route": "/api/checkout" },
                 "points": [2, 9, 28, 75, 160, 268] } ]      // see §5
}
```

Three scenarios: `payment-db-down` (SEV1), `latency-regression` (SEV2, redis pool exhausted),
`inventory-crashloop` (SEV1, OOMKilled → gRPC deadlines). All data synthetic.

## 4 · OTLP payload rules (the fix for the `undefined` service bug)

- Content type: `application/json` to the collector's OTLP/HTTP receiver (`:4318/v1/traces`, `/v1/metrics`).
- **Enums as proto3-JSON string names**: `"kind": "SPAN_KIND_SERVER" | "SPAN_KIND_CLIENT" | "SPAN_KIND_INTERNAL"`,
  `"status": { "code": "STATUS_CODE_ERROR" }`. Integer enums are invalid proto3 JSON — this is what
  corrupted the aborted run.
- Int64s as strings: `startTimeUnixNano`, `endTimeUnixNano`, `timeUnixNano`.
- Attribute values typed: `{ "stringValue" }`, `{ "intValue" }`, `{ "doubleValue" }`, `{ "boolValue" }`.
- One `resourceSpans` entry per service, with `resource.attributes[]` carrying `service.name`.
- Cross-service traces: same `traceId`, children reference `parentSpanId`.
- Metrics: counters use `sum { isMonotonic: true, aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE" }`,
  latency uses `gauge`.

## 5 · Metric series design (the fix for counter-reset nonsense)

**All seeded counters are monotonic cumulative.** The incident shape lives in the *deltas*:

| scenario | series | points (cumulative) | deltas tell |
|---|---|---|---|
| payment-db-down | 500s on /api/checkout | 2, 9, 28, 75, 160, 268 | accelerating failure |
| payment-db-down | 200s on /api/checkout | 940, 1845, 2655, 3245, 3545, 3655 | decelerating success |
| latency-regression | 504s on /api/cart | 0, 3, 11, 26, 44, 61 | slow 504 creep |
| latency-regression | 200s on /api/cart | 880, 1740, 2530, 3170, 3600, 3860 | throughput sagging |
| inventory-crashloop | container_restarts_total | 4, 9, 15, 22, 31, 42 | crash-loop |
| inventory-crashloop | 500s on /api/checkout | 5, 18, 40, 77, 131, 190 | blast onto checkout |

Gauges (`http_request_duration_seconds`) may move freely — only counters must be monotonic.

## 6 · Standard triage queries (PromQL, fixed set)

```promql
increase(http_requests_total{service="S",status=~"5.."}[W])
increase(http_requests_total{service="S",status="200"}[W])
http_request_duration_seconds{service="S"}
increase(container_restarts_total{service=~"S.*"}[W])
```

`W = sinceMinutes + 5` (window margin). A query with no series is not an error — the UI shows "no series".
