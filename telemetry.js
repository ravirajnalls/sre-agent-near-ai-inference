// Fetches latest error data from Jaeger + Prometheus and builds the evidence
// object sent to the Confidential TEE model. Nothing is stored: this object
// exists for the duration of one request.

import { fetchErrorTraces, spanRows } from "./jaeger-client.js";
import { fetchMetrics } from "./prom-client.js";

export async function fetchTelemetry({ service, sinceMinutes, maxTraces }) {
  const since = Math.max(1, Math.min(Number(sinceMinutes) || 30, 240));
  const max = Math.max(1, Math.min(Number(maxTraces) || 20, 50));
  const svc = String(service || "checkout").slice(0, 64);

  const [jRes, pRes] = await Promise.allSettled([
    fetchErrorTraces({ service: svc, sinceMinutes: since, maxTraces: max }),
    fetchMetrics({ service: svc, sinceMinutes: since }),
  ]);
  if (jRes.status === "rejected" && pRes.status === "rejected") {
    throw new Error(
      `No telemetry reachable — Jaeger: ${shortReason(jRes.reason)}; Prometheus: ${shortReason(pRes.reason)}`,
    );
  }
  const jaeger =
    jRes.status === "fulfilled"
      ? jRes.value
      : { query: "(unreachable)", traces: [], error: shortReason(jRes.reason) };
  const metrics = pRes.status === "fulfilled" ? pRes.value : [];

  const to = new Date();
  const from = new Date(to.getTime() - since * 60_000);
  return {
    service: svc,
    sinceMinutes: since,
    window: { from: from.toISOString(), to: to.toISOString() },
    jaeger,
    metrics,
  };
}

/** UI-facing view: queries used, error span rows, metric series. */
export function toUi(telemetry) {
  const rows = spanRows(telemetry.jaeger.traces);
  return {
    service: telemetry.service,
    window: telemetry.window,
    sinceMinutes: telemetry.sinceMinutes,
    queries: {
      jaeger: telemetry.jaeger.query,
      jaegerError: telemetry.jaeger.error || null,
      prometheus: telemetry.metrics.map((m) => m.query),
    },
    traceCount: telemetry.jaeger.traces.length,
    errorSpans: rows,
    metrics: telemetry.metrics.map((m) => ({
      query: m.query,
      series: m.series.map((s) => ({ labels: s.labels, lastValue: s.lastValue })),
    })),
  };
}

/** Compact evidence object for the model — capped so the prompt stays small. */
export function buildEvidence(telemetry) {
  const traces = telemetry.jaeger.traces.slice(0, 8).map((t) => ({
    services: [...new Set(t.spans.map((s) => s.service))],
    spans: t.spans.slice(0, 8).map((s) => ({
      service: s.service,
      operation: s.operation,
      route: s.tags["http.route"] ?? null,
      statusCode: s.tags["http.status_code"] ?? null,
      durationMs: s.durationMs,
      exception: {
        type: pickLog(s, "exception.type") ?? s.tags["exception.type"] ?? null,
        message: pickLog(s, "exception.message") ?? s.tags["exception.message"] ?? null,
      },
    })),
  }));
  return {
    mode: "telemetry",
    window: {
      service: telemetry.service,
      minutes: telemetry.sinceMinutes,
      from: telemetry.window.from,
      to: telemetry.window.to,
    },
    errorTraces: telemetry.jaeger.traces.length,
    traces,
    metrics: telemetry.metrics
      .filter((m) => m.series.length)
      .map((m) => ({
        query: m.query,
        series: m.series.slice(0, 6).map((s) => ({ labels: s.labels, value: s.lastValue })),
      })),
  };
}

function pickLog(span, key) {
  return span.logFields.find((f) => f.key === key)?.value ?? null;
}

function shortReason(e) {
  return String(e?.message || e).slice(0, 160);
}
