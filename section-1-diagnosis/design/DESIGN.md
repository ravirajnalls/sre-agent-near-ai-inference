# Section 1 — Sealed Diagnosis: Design (master document)

> For on-call engineers, the Attested Agent Sandbox finds root cause in production incident logs inside a TEE, because logs can't go elsewhere.

**This is Section 1 of a two-section project.** Section 1 (this document) delivers **sealed diagnosis**:
query latest error telemetry → assemble evidence → Confidential TEE model call with the receipt
surfaced in the UI. Section 2 — **gated remediation** (redacting collector, boxed agent, NEAR
contract gate, executor) — is designed in [`../section-2-gating/DESIGN.md`](../../section-2-gating/DESIGN.md)
and builds on top of this section through Nov 14.

**Status: built Nov 11.** ADR-004 was superseded during the build (see the table).

## 1 · Problem

The highest-signal incident data — error spans, exception messages, failing routes, error-rate spikes — is exactly the data you may not paste into a normal chatbot: customer tokens, internal topology, PII, secrets. Triage stays manual, slow and tribal.

## 2 · Solution (one paragraph)

Telemetry already lives in your observability stack. The user picks **service + time window** in a web UI. The app queries the **latest error data** from **Jaeger** (traces) and **Prometheus** (metrics), assembles a compact evidence object, and sends it to a **Confidential TEE model on NEAR AI Cloud** — where prompt and output are hidden from everyone, NEAR included. The UI renders a structured triage report (root cause, blast radius, ranked actions) plus a **privacy panel** showing the tier, any attestation metadata the API returns, and an honest scope statement. The app itself is **zero-retention**.

## 3 · Goals / non-goals

**Goals**
- Demoable by 4:30 PM code freeze, by one person, in 3–5 minutes
- Privacy is *visible on screen*: tier badge, attestation/metadata receipt, honest scope line
- Real query APIs (Jaeger HTTP, PromQL) — SRE judges recognize them
- Zero retention, provable: no DB, no files, logs carry sizes/timings only

**Non-goals (today)**
- No Kubernetes deployment, no auth/multi-tenant, no streaming/SSE
- No log storage backend (spans + metrics carry the incident signal)
- No agent loop / tool-calling — a single well-structured triage call

## 4 · System overview (v4)

```
┌────────────────────────── laptop · docker compose (3 containers) ─────────────────────┐
│                                                                                         │
│  seed-incident (Node CLI / one click in UI)                                             │
│    3 synthetic incidents as span trees + error-rate metric series                      │
│         │ OTLP/HTTP JSON (proto3-JSON enums as string names)                            │
│         ▼                                                                               │
│  ┌────────────────────────┐        OTLP gRPC ─► Jaeger all-in-one                      │
│  │ OpenTelemetry Collector │                        trace store + query API :16686     │
│  │  otlp receiver :4318    │   (metrics go seeder ► Prometheus OTLP receiver :9090)      │
│  └────────────────────────┘                        (see ADR-004, superseded)            │
└────────┬──────────────────────────────┬────────────────────────────────────────────────┘
         │ GET /api/traces              │ GET /api/v1/query_range
         │ ?service&start&end&limit     │ ?query=<PromQL>
         ▼                              ▼
┌────────────────── Attested Agent Sandbox S1 · Node + Express, one process ──────────────┐
│  GET  /api/health · GET /api/scenarios · POST /api/seed                                │
│  POST /api/telemetry  → latest error spans + metric series (UI preview)               │
│  POST /api/triage     → evidence → NEAR AI Cloud (TEE) → report (+ privacy metadata)   │
│                                                                                         │
│  Error-span filtering happens in our code (ADR-010) — no Jaeger tags-query dependency   │
│  Nothing persisted; logs = sizes + timings; key never leaves this process              │
└────────────────────────────┬────────────────────────────────────────────────────────────┘
                             │ HTTPS · Bearer $NEARAI_API_KEY (env only)
                             ▼
              NEAR AI Cloud — cloud-api.near.ai/v1
              z-ai/glm-5.3-flash · Confidential TEE · thinking OFF
```

## 5 · Architecture decision records (ADRs)

| # | Decision | Rationale |
|---|---|---|
| 001 | Node 20+ / Express, vanilla HTML+JS, no build step | one process, fewest demo failure modes, 4-hour solo budget |
| 002 | Zero persistence (no DB, no files, in-request state only) | true and demonstrable — "nothing is stored" is the privacy story |
| 003 | Jaeger all-in-one as trace store | OTLP receiver + query API in one container; error spans carry root-cause signal |
| 004 | ~~Prometheus via standard remote-write from the collector~~ **Superseded:** metrics go straight from the seeder to Prometheus 3's native OTLP receiver (`--web.enable-otlp-receiver`); the collector carries traces only | the `prometheusremotewrite` exporter rejected multi-point cumulative series as "out of order" on fresh stores |
| 005 | **OTel Collector between seeder and stores** | canonical OTel pipeline (matches the stack's own story); validates OTLP payloads strictly (catches bad payloads loudly instead of storing garbage); fans out to Jaeger + Prometheus |
| 006 | Seed as OTLP/HTTP **JSON with proto3-JSON string enums** (`"SPAN_KIND_SERVER"`, `"STATUS_CODE_ERROR"`) | the aborted run stored spans under service `undefined` — integer enums are invalid proto3 JSON; string names are the spec-correct encoding |
| 007 | Model `z-ai/glm-5.3-flash`, `enable_thinking: false`, temp 0.2, 60 s abort timeout | Confidential TEE tier + latency a live demo survives |
| 008 | Strict JSON report schema; one retry-nudge; raw-text fallback | renderable UI, graceful degradation, never an error screen |
| 009 | Attestation capture = whatever headers/body fields match attest/proof/quote/tee patterns; panel degrades to tier badge + response metadata | never fake a receipt; show what the API actually returns |
| 010 | **Query Jaeger by service + time range only; filter error spans in our code** | the aborted run got HTTP 400 on the `tags` param; removing it drops a version-sensitive dependency entirely |
| 011 | Seeded counters are **monotonic cumulative** (shape lives in the deltas) | Prometheus treats a decreasing "counter" as a reset and extrapolates nonsense; 200-success slowing down is expressed as decelerating deltas |
| 012 | Paste-bundle mode as a secondary tab through the same triage core | fallback if telemetry hiccups; also demos arbitrary input |
| 013 | Key handling: `.env` (gitignored) → server env only; error messages sanitized (`sk-…` masked); logs never contain evidence or model output | hackpack rule #1 |

## 6 · Lessons from the aborted run, folded into this design

| Symptom observed | Root cause | Design fix |
|---|---|---|
| Jaeger services list showed `undefined`; query by service returned nothing | OTLP JSON used integer enum values (invalid proto3 JSON) | ADR-006 string enums + ADR-005 collector validates strictly |
| Jaeger query HTTP 400 | `tags={"error":true}` param not accepted | ADR-010 drop the param, filter client-side |
| `increase()` on the 200-series returned 3800 instead of a negative delta | non-monotonic counter → Prometheus reset heuristic | ADR-011 cumulative monotonic counters |
| Server died when my shell dropped | background shell tied to the harness | execution plan runs the server as a detached process |

## 7 · Document map

- [API-CONTRACT.md](API-CONTRACT.md) — endpoints, request/response schemas, error model
- [DATA-MODELS.md](DATA-MODELS.md) — evidence, report, seed specs, OTLP payload rules
- [PRIVACY-MODEL.md](PRIVACY-MODEL.md) — trust boundaries, threats, controls, residual risks
- [UI-DESIGN.md](UI-DESIGN.md) — wireframes, interaction flow, demo script
- [VERIFICATION-AND-EXECUTION-PLAN.md](VERIFICATION-AND-EXECUTION-PLAN.md) — staged go/no-go gates, timeline, freeze plan
