# Verification & execution plan

Execution proceeds **stage by stage with go/no-go gates**. A failed gate gets one fix attempt,
then we take the documented fallback and move on — the demo at 4:30 matters more than purity.

## Gates

### V0 — key & model call (before any UI work)
- Put the key in `.env` (never in chat, never on screen).
- One curl to `cloud-api.near.ai/v1/chat/completions` with `z-ai/glm-5.3-flash`,
  `enable_thinking:false`, a tiny "return `{\"ok\":true}`" prompt.
- **Pass:** valid JSON reply in < 30 s; response headers/body scanned for attestation fields (note what exists).
- **Fallback:** none needed — if the key/credits are broken, stop and resolve (nearbuilders.org/dashboard).

### V1 — telemetry stack up
- `docker compose up -d` (collector + jaeger + prometheus, 3 containers).
- `GET localhost:16686/api/services`, `GET localhost:9090/-/healthy`, collector health endpoint.
- **Pass:** all three healthy.

### V2 — seeding lands correctly (the gate the aborted run failed)
- Seed `payment-db-down`.
- `GET localhost:16686/api/services` must list `checkout` and `payment` (**not** `undefined`).
- `GET localhost:16686/api/traces?service=checkout&start=…&end=…&limit=5` returns traces with
  error spans; Prometheus `increase(http_requests_total{status=~"5.."}[35m])` returns ≈ 266.
- **Fallback A (enum/JSON still rejected):** collector pipeline validated against
  `otelcol --dry-run` or switch the seeder to OTLP/gRPC via `@opentelemetry/exporter-trace-otlp-http`… if
  JSON keeps failing, emit protobuf via the official exporter package (adds a dependency — acceptable).
- **Fallback B (tags query fails again):** already designed out (ADR-010 — service+window only).

### V3 — backend endpoints
- `POST /api/telemetry` returns spans + series; `POST /api/triage` in paste mode with a tiny bundle
  returns a parsed report; `GET /api/health` all green.
- **Pass:** end-to-end minus telemetry; retry-nudge path exercised once deliberately.

### V4 — UI flow
- Seed → fetch → triage in the browser; all states from UI-DESIGN §3 render correctly.
- **Pass:** the 3-minute demo script runs clean twice in a row.

### V5 — privacy panel truth check
- Receipt shows whatever V0 observed (or the graceful degradation); scope line present; no claim
  stronger than PRIVACY-MODEL.md.
- `git grep -i "sk-"` → empty; `.env` untracked; `git status` clean of secrets.

### V6 — rehearsal
- Full demo script out loud, timed, with the projector font size. Cache one fallback report JSON
  (`public/demo-fallback.json`) + banner, in case the live call stalls at 4:30.

## Build order (code)

1. `docker-compose.yml` + `otel-collector.config.yaml` (receivers: otlp; exporters: otlp→jaeger, remote_write→prom)
2. Seeder rewrite per DATA-MODELS §4–5 (string enums, monotonic counters, per-service resourceSpans)
3. `jaeger-client.js` (no tags param, client-side error filter), `prom-client.js` (fixed queries)
4. `telemetry.js` evidence builder + caps
5. `near-client.js` (60 s AbortController, attestation capture), `prompt.js`
6. `server.js` endpoints + logging policy
7. `public/` UI per UI-DESIGN
8. README polish, demo-fallback cache, submission checklist

Existing scaffold from the aborted run is reused **where it matches this design** (server skeleton,
UI, prompt, prom queries) and rewritten where it doesn't (seeder payloads, jaeger query, compose
stack). The design is the source of truth, not the old code.

## Timeline (freeze 4:30 PM ET)

| Slot | Work | Gate |
|---|---|---|
| 0:00–0:20 | V0 key + model probe | V0 |
| 0:20–0:50 | compose stack + seeder rewrite | V1, V2 |
| 0:50–1:20 | clients + evidence + server | V3 |
| 1:20–2:10 | UI | V4 |
| 2:10–2:30 | privacy panel + truth check | V5 |
| 2:30–3:00 | dry runs ×2, README, fallback cache | V6 |
| 3:00–4:00 | buffer / polish / rehearse | — |
| 4:15 | stop everything | freeze 4:30 |

## Abort criteria (drop scope, keep the demo)

- V2 fallback A fails too → drop live telemetry from the demo; run **paste mode** with the seeded
  bundle text pre-staged in the textarea (same TEE call, same report, same privacy panel).
- Live model call > 45 s at demo time → switch to the cached fallback + banner (honesty preserved).
- Jaeger UI adds credibility but is not required for the demo — the app's own telemetry view suffices.

## Post-freeze / submission

- Repo public, README = what it does + how to run
- X demo post: tags @buidlcity @NEARProtocol @nearlegion #NEARHackathon, video/screenshots
- Form: repo link, X post link, mainnet NEAR payout account — **before Sat Nov 14, 6:59 PM ET**
- Final `git grep -i "sk-"` before pushing
