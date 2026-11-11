// Jaeger query client — real HTTP API, nothing faked.

/**
 * Fetch the latest traces for a service and keep only the error spans.
 * ADR-010: we query by service + time range only (no Jaeger `tags` param — it
 * proved version-fragile) and filter error spans in our own code.
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
  });
  const url = `${base}/api/traces?${params}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Jaeger HTTP ${res.status}`);
  const json = await res.json();

  const traces = (json.data || [])
    .map((t) => ({
      traceID: t.traceID,
      spans: (t.spans || [])
        .filter(isErrorSpan)
        .map((s) => ({
          service: t.processes?.[s.processID]?.serviceName || "unknown",
          operation: s.operationName,
          startMs: Math.round(s.startTime / 1000),
          durationMs: Math.round(s.duration / 1000),
          tags: tagMap(s.tags),
          logFields: (s.logs || []).flatMap((l) => (l.fields || []).map((f) => ({ key: f.key, value: f.value }))),
        })),
    }))
    .filter((t) => t.spans.length > 0);

  const query = `${base}/api/traces?service=${encodeURIComponent(service)}&start=<${sinceMinutes}m ago>&limit=${maxTraces}`;
  return { query, traces };
}

/** An error span: error tag, ERROR status, or an exception event/attribute. */
function isErrorSpan(span) {
  const tags = tagMap(span.tags);
  if (tags.error === true || tags["otel.status_code"] === "ERROR") return true;
  if (tags["exception.type"] || tags["exception.message"]) return true;
  return (span.logs || []).some((l) => (l.fields || []).some((f) => f.key === "exception.type" || f.key === "exception.message"));
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
