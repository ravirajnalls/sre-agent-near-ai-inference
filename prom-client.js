// Prometheus query client — real PromQL over the HTTP API.

/** The standard triage queries: 5xx volume, success contrast, current latency, restarts. */
export function buildQueries(service, windowMinutes) {
  const safe = String(service).replace(/["}\\]/g, "");
  return [
    `increase(http_requests_total{service="${safe}",status=~"5.."}[${windowMinutes}m])`,
    `increase(http_requests_total{service="${safe}",status="200"}[${windowMinutes}m])`,
    `http_request_duration_seconds{service="${safe}"}`,
    `increase(container_restarts_total{service=~"${safe}.*"}[${windowMinutes}m])`,
  ];
}

export async function fetchMetrics({ service, sinceMinutes }) {
  const base = process.env.PROM_URL || "http://localhost:9090";
  const endSec = Math.floor(Date.now() / 1000);
  const startSec = endSec - sinceMinutes * 60;
  const queries = buildQueries(service, sinceMinutes + 5);
  const results = await Promise.allSettled(
    queries.map(async (query) => {
      const params = new URLSearchParams({
        query,
        start: String(startSec),
        end: String(endSec),
        step: "15",
      });
      const res = await fetch(`${base}/api/v1/query_range?${params}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Prometheus HTTP ${res.status}`);
      const json = await res.json();
      if (json.status !== "success") throw new Error("Prometheus query failed");
      const series = (json.data?.result || []).map((r) => ({
        labels: r.metric,
        lastValue: r.values?.length ? Number(r.values[r.values.length - 1][1]) : null,
        points: (r.values || []).map((v) => Number(v[1])),
      }));
      return { query, series };
    }),
  );
  // A failing query degrades to an empty series list rather than killing the triage.
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { query: queries[i], series: [], error: String(r.reason?.message || r.reason).slice(0, 120) },
  );
}
