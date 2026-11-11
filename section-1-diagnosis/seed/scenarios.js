// Synthetic incident seeder. Emits OTLP/HTTP JSON — the same wire format a real
// instrumented service would send — to Jaeger (:4318) and Prometheus (OTLP write receiver).
// All services, exceptions and numbers are fictional.

const JAEGER_OTLP = () => process.env.JAEGER_OTLP_URL || "http://localhost:4318";
const PROM = () => process.env.PROM_URL || "http://localhost:9090";

const KIND = { internal: 1, server: 2, client: 3 };

function hex(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return s;
}

function attr(k, v) {
  const value =
    typeof v === "boolean"
      ? { boolValue: v }
      : typeof v === "number"
        ? Number.isInteger(v)
          ? { intValue: v }
          : { doubleValue: v }
        : { stringValue: String(v) };
  return { key: k, value };
}

/** Build one OTLP span from a compact spec. */
function makeSpan({ traceId, spanId, parentSpanId, service, name, kind, startMs, durationMs, attrs = {}, exception = null, error = false }) {
  const attributes = Object.entries(attrs).map(([k, v]) => attr(k, v));
  const events = [];
  if (error) {
    attributes.push(attr("error", true));
    attributes.push(attr("otel.status_code", "ERROR"));
    if (exception?.type) attributes.push(attr("exception.type", exception.type));
    if (exception?.message) attributes.push(attr("exception.message", exception.message));
    events.push({
      timeUnixNano: String(Math.round((startMs + Math.round(durationMs / 2)) * 1e6)),
      name: "exception",
      attributes: [
        ...(exception?.type ? [attr("exception.type", exception.type)] : []),
        ...(exception?.message ? [attr("exception.message", exception.message)] : []),
        attr("exception.stacktrace", "(synthetic)"),
      ],
    });
  }
  const span = {
    traceId,
    spanId,
    name,
    kind: KIND[kind] ?? 1,
    startTimeUnixNano: String(Math.round(startMs * 1e6)),
    endTimeUnixNano: String(Math.round((startMs + durationMs) * 1e6)),
    attributes,
    ...(events.length ? { events } : {}),
    status: error ? { code: 2, ...(exception?.message ? { message: exception.message.slice(0, 200) } : {}) } : { code: 1 },
  };
  if (parentSpanId) span.parentSpanId = parentSpanId;
  return span;
}

/** Walk a span tree, assigning ids and timing, returning flat OTLP spans. */
function buildSpans(root, { traceId, startMs }) {
  const spans = [];
  const walk = (node, parentSpanId, start, duration) => {
    const spanId = hex(16);
    spans.push(
      makeSpan({
        traceId,
        spanId,
        parentSpanId,
        service: node.service,
        name: node.name,
        kind: node.kind,
        startMs: start,
        durationMs: Math.max(1, duration),
        attrs: node.attrs,
        exception: node.exception,
        error: node.error,
      }),
    );
    let offset = 2;
    for (const child of node.children || []) {
      walk(child, spanId, start + offset, Math.max(1, duration - offset - 1));
      offset += 1;
    }
  };
  walk(root, null, startMs, root.durationMs);
  return spans;
}

async function pushTrace(spans) {
  const byService = new Map();
  for (const s of spans) {
    if (!byService.has(s.service)) byService.set(s.service, []);
    byService.get(s.service).push(s);
  }
  const resourceSpans = [...byService.entries()].map(([service, svcSpans]) => ({
    resource: { attributes: [attr("service.name", service)] },
    scopeSpans: [{ scope: { name: "attested-agent-sandbox-seed" }, spans: svcSpans }],
  }));
  const res = await fetch(`${JAEGER_OTLP()}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceSpans }),
  });
  if (!res.ok) throw new Error(`Jaeger OTLP push HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

async function pushMetrics(metrics, startMs, stepMs) {
  const steps = Math.max(...metrics.map((m) => m.points.length));
  let pushes = 0;
  for (let i = 0; i < steps; i++) {
    const ts = startMs + i * stepMs;
    const payload = metrics
      .filter((m) => i < m.points.length)
      .map((m) => {
        const dataPoints = [
          {
            attributes: Object.entries(m.labels).map(([k, v]) => attr(k, v)),
            ...(m.type === "counter" ? { startTimeUnixNano: String(Math.round(startMs * 1e6)) } : {}),
            timeUnixNano: String(Math.round(ts * 1e6)),
            asDouble: m.points[i],
          },
        ];
        return m.type === "counter"
          ? { name: m.name, sum: { isMonotonic: true, aggregationTemporality: 2, dataPoints } }
          : { name: m.name, gauge: { dataPoints } };
      });
    if (!payload.length) continue;
    const body = {
      resourceMetrics: [
        {
          resource: { attributes: [attr("service.name", "seed")] },
          scopeMetrics: [{ scope: { name: "attested-agent-sandbox-seed" }, metrics: payload }],
        },
      ],
    };
    const res = await fetch(`${PROM()}/api/v1/otlp/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Prometheus OTLP push HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    pushes++;
  }
  return pushes;
}

// ---------------------------------------------------------------------------
// Scenarios — all synthetic.
// ---------------------------------------------------------------------------

const paymentDbDown = (windowMs, n) => ({
  traces: Array.from({ length: n }, (_, i) => ({
    startMs: Date.now() - windowMs + ((i + 1) * windowMs) / (n + 1),
    tree: {
      service: "checkout",
      name: "POST /api/checkout",
      kind: "server",
      durationMs: 1730 + Math.floor(Math.random() * 500),
      error: true,
      exception: {
        type: "java.net.ConnectTimeoutException",
        message: "connect timed out calling payments:5432 after 3 attempts",
      },
      attrs: { "http.route": "/api/checkout", "http.method": "POST", "http.status_code": 500 },
      children: [
        {
          service: "checkout",
          name: "payments.authorize",
          kind: "client",
          durationMs: 1700,
          error: true,
          exception: { type: "java.net.ConnectTimeoutException", message: "upstream timeout calling payment:8080" },
          attrs: { "peer.service": "payment" },
          children: [],
        },
        {
          service: "payment",
          name: "POST /v1/authorize",
          kind: "server",
          durationMs: 1680,
          error: true,
          exception: {
            type: "org.postgresql.util.PSQLException",
            message: "Connection to payments-db:5432 refused. Check that the host and port are correct.",
          },
          attrs: { "http.route": "/v1/authorize", "http.status_code": 500, "db.system": "postgresql", "db.name": "payments" },
          children: [
            {
              service: "payment",
              name: "pg insert txn",
              kind: "client",
              durationMs: 1600,
              error: true,
              exception: { type: "org.postgresql.util.PSQLException", message: "connection to payments-db:5432 refused" },
              attrs: { "db.system": "postgresql", "db.operation": "INSERT", "peer.service": "payments-db" },
              children: [],
            },
          ],
        },
      ],
    },
  })),
  metrics: [
    { name: "http_requests_total", type: "counter", labels: { service: "checkout", status: "500", route: "/api/checkout" }, points: [2, 9, 28, 75, 160, 268] },
    { name: "http_requests_total", type: "counter", labels: { service: "checkout", status: "200", route: "/api/checkout" }, points: [940, 905, 810, 590, 300, 110] },
    { name: "http_request_duration_seconds", type: "gauge", labels: { service: "checkout", route: "/api/checkout" }, points: [0.31, 0.34, 0.62, 1.1, 1.61, 1.94] },
  ],
});

const latencyRegression = (windowMs, n) => ({
  traces: Array.from({ length: n }, (_, i) => ({
    startMs: Date.now() - windowMs + ((i + 1) * windowMs) / (n + 1),
    tree: {
      service: "checkout",
      name: "GET /api/cart",
      kind: "server",
      durationMs: 2900 + Math.floor(Math.random() * 1200),
      error: true,
      exception: {
        type: "redis.clients.jedis.exceptions.JedisConnectionException",
        message: "Could not get a resource from the pool (pool exhausted, waited 1900ms)",
      },
      attrs: { "http.route": "/api/cart", "http.method": "GET", "http.status_code": 504 },
      children: [
        {
          service: "checkout",
          name: "redis get cart:{customer}",
          kind: "client",
          durationMs: 1900,
          error: true,
          exception: {
            type: "redis.clients.jedis.exceptions.JedisConnectionException",
            message: "pool exhausted: maxTotal=50, waiting 1900ms",
          },
          attrs: { "db.system": "redis", "db.operation": "GET", "peer.service": "redis-cart" },
          children: [
            {
              service: "redis-cart",
              name: "redis GET",
              kind: "server",
              durationMs: 1850,
              error: true,
              exception: {
                type: "io.lettuce.core.RedisCommandTimeoutException",
                message: "Command timed out after 1500ms (GET cart:*)",
              },
              attrs: { "db.system": "redis", "db.operation": "GET" },
              children: [],
            },
          ],
        },
      ],
    },
  })),
  metrics: [
    { name: "http_requests_total", type: "counter", labels: { service: "checkout", status: "504", route: "/api/cart" }, points: [0, 3, 11, 26, 44, 61] },
    { name: "http_requests_total", type: "counter", labels: { service: "checkout", status: "200", route: "/api/cart" }, points: [880, 860, 790, 640, 430, 260] },
    { name: "http_request_duration_seconds", type: "gauge", labels: { service: "checkout", route: "/api/cart" }, points: [0.42, 1.1, 1.95, 2.6, 3.2, 3.8] },
  ],
});

const inventoryCrashloop = (windowMs, n) => ({
  traces: Array.from({ length: n }, (_, i) => ({
    startMs: Date.now() - windowMs + ((i + 1) * windowMs) / (n + 1),
    tree: {
      service: "checkout",
      name: "inventory.checkStock",
      kind: "client",
      durationMs: 5000,
      error: true,
      exception: {
        type: "io.grpc.DeadlineExceededException",
        message: "deadline exceeded after 4990ms calling inventory:8080",
      },
      attrs: { "peer.service": "inventory", "rpc.system": "grpc", "rpc.method": "CheckStock" },
      children: [
        {
          service: "inventory",
          name: "inventory.CheckStock",
          kind: "server",
          durationMs: 4900,
          error: true,
          exception: {
            type: "java.lang.OutOfMemoryError",
            message: "Java heap space — container inventory-api limit 512Mi, exit code 137 (OOMKilled)",
          },
          attrs: {
            "rpc.method": "CheckStock",
            "k8s.pod.name": "inventory-api-7d9f6c8b5-x2k9q",
            "k8s.namespace": "prod",
            "http.status_code": 503,
          },
          children: [
            {
              service: "inventory",
              name: "load catalog shard",
              kind: "internal",
              durationMs: 4800,
              error: true,
              exception: { type: "java.lang.OutOfMemoryError", message: "Java heap space while loading 18432 catalog rows" },
              attrs: { "cache.hit": false },
              children: [],
            },
          ],
        },
      ],
    },
  })),
  metrics: [
    { name: "container_restarts_total", type: "counter", labels: { service: "inventory", pod: "inventory-api-7d9f6c8b5-x2k9q" }, points: [4, 9, 15, 22, 31, 42] },
    { name: "http_requests_total", type: "counter", labels: { service: "checkout", status: "500", route: "/api/checkout" }, points: [5, 18, 40, 77, 131, 190] },
    { name: "http_request_duration_seconds", type: "gauge", labels: { service: "checkout", route: "/api/checkout" }, points: [0.9, 2.2, 3.1, 3.9, 4.6, 4.9] },
  ],
});

export const SCENARIOS = {
  "payment-db-down": {
    title: "payment-db-down",
    severity: "SEV1",
    service: "checkout",
    summary: "checkout 500s — payment authorize timing out, payments-db refusing connections",
    build: paymentDbDown,
    traceCount: 5,
  },
  "latency-regression": {
    title: "latency-regression",
    severity: "SEV2",
    service: "checkout",
    summary: "cart 504s and slow responses — redis connection pool exhausted",
    build: latencyRegression,
    traceCount: 5,
  },
  "inventory-crashloop": {
    title: "inventory-crashloop",
    severity: "SEV1",
    service: "checkout",
    summary: "inventory OOMKilled crash-loop — checkout gRPC deadlines exceeded",
    build: inventoryCrashloop,
    traceCount: 6,
  },
};

/** Push one scenario's traces + metrics. Returns counts. */
export async function seedScenario(id, { windowMinutes = 30 } = {}) {
  const scenario = SCENARIOS[id];
  if (!scenario) throw new Error(`Unknown scenario '${id}'. Available: ${Object.keys(SCENARIOS).join(", ")}`);
  const windowMs = windowMinutes * 60_000;
  const { traces, metrics } = scenario.build(windowMs, scenario.traceCount);
  for (const t of traces) {
    await pushTrace(buildSpans(t.tree, { traceId: hex(32), startMs: t.startMs }));
  }
  const stepMs = windowMs / 6;
  const metricPushes = await pushMetrics(metrics, Date.now() - windowMs, stepMs);
  return {
    scenario: id,
    severity: scenario.severity,
    suggestedService: scenario.service,
    windowMinutes,
    tracesPushed: traces.length,
    metricPushes,
  };
}
