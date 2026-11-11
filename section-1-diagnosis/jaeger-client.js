// Jaeger query client — real HTTP API, nothing faked.

/**
 * Fetch the latest error traces for a service.
 * Jaeger REST: GET /api/traces?service=…&tags={"error":true}&start=…&end=… (microseconds)
 */
export async function fetchErrorTraces({ service, sinceMinutes, maxTraces = 20 }) {
  const base = process.env.JAEGER_URL || "http://localhost:16686";
  const endMicros = Date.now() * 1000;
  const startMicros = endMicros - sinceMinutes * 60 * 1e6;
  const params = new URLSearchParams({
    service,
    start: String(startMicros),
    end: String(endMicros),
    limit: String(maxTraces),
    tags: JSON.stringify({ error: true }),
  });
  const url = `${base}/api/traces?${params}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Jaeger HTTP ${res.status}`);
  const json = await res.json();

  const traces = (json.data || []).map((t) => ({
    traceID: t.traceID,
    spans: (t.spans || []).map((s) => ({
      service: t.processes?.[s.processID]?.serviceName || "unknown",
      operation: s.operationName,
      startMs: Math.round(s.startTime / 1000),
      durationMs: Math.round(s.duration / 1000),
      tags: tagMap(s.tags),
      logFields: (s.logs || []).flatMap((l) => (l.fields || []).map((f) => ({ key: f.key, value: f.value }))),
    })),
  }));

  const query = `${base}/api/traces?service=${encodeURIComponent(service)}&tags=${encodeURIComponent(
    '{"error":true}',
  )}&start=<${sinceMinutes}m ago>&limit=${maxTraces}`;
  return { query, traces };
}

function tagMap(tags) {
  const out = {};
  for (const t of tags || []) out[t.key] = t.value;
  return out;
}

/** Flatten trace spans into UI/report rows with the fields that matter for triage. */
export function spanRows(traces) {
  const rows = [];
  for (const t of traces) {
    for (const s of t.spans) {
      const exceptionType = s.logFields.find((f) => f.key === "exception.type")?.value;
      const exceptionMessage = s.logFields.find((f) => f.key === "exception.message")?.value;
      rows.push({
        traceID: t.traceID.slice(0, 8),
        service: s.service,
        operation: s.operation,
        statusCode: s.tags["http.status_code"] ?? null,
        route: s.tags["http.route"] ?? s.tags["db.operation"] ?? null,
        durationMs: s.durationMs,
        exceptionType: exceptionType ?? s.tags["exception.type"] ?? null,
        exceptionMessage: exceptionMessage ?? s.tags["exception.message"] ?? null,
        startMs: s.startMs,
      });
    }
  }
  return rows.sort((a, b) => b.startMs - a.startMs);
}
