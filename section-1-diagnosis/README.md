# Attested Agent Sandbox — Section 1: Sealed Diagnosis

> For on-call engineers, the Attested Agent Sandbox finds root cause in production incident logs inside a TEE, because logs can't go elsewhere.

Built at the **NEAR Private AI Hackathon NYC** (Build City, Nov 11, 2026) for Track 3 — Privacy & Private AI.

## The problem

The highest-signal incident data — error spans, exception messages, failing routes, error-rate spikes — is exactly what you can't paste into a normal chatbot: it contains customer tokens, internal topology, PII, secrets. So triage stays manual and slow.

## What Section 1 does

1. Your telemetry already lives in **Jaeger** (traces) and **Prometheus** (metrics).
2. You pick a **service + time window**; the app queries the **latest error data** — nothing is copy-pasted, nothing is exported.
3. The evidence is analyzed by a **Confidential TEE model on NEAR AI Cloud** (`z-ai/glm-5.3-flash`): prompt and output are hidden from everyone — NEAR included.
4. You get a structured triage report: root cause with cited evidence, blast radius across the service topology, ranked next actions with real commands, severity.
5. The **privacy panel** shows the model tier, the attestation/metadata receipt, and exactly what left your machine.

The app itself is **zero-retention**: no database, no files, no logs of your telemetry — the evidence exists only for the duration of one request.

## Privacy model

| Tier | Runs where | Private? |
|---|---|---|
| **Confidential TEE** (used here) | NEAR's own GPUs | **Yes.** Prompt and output hidden from everyone, NEAR included |
| Attested 3P | a third-party TEE | encrypted path; provider publishes its own proof |
| Incognito | provider's servers | gateway-only TEE — not private end-to-end |

Stated plainly in the UI: **only the model call is private.** Your laptop, this server and the telemetry it fetches sit outside the TEE. The API key exists only in the server's environment, never in the repo or the browser.

## Run it

Prerequisites: Docker, Node 20+, a NEAR AI Cloud API key ([nearbuilders.org/dashboard](https://nearbuilders.org/dashboard) — $10 in credits for hackathon builders).

```bash
cd section-1-diagnosis
docker compose up -d          # Jaeger (16686) + Prometheus (9090) + OTel Collector (4318)
npm install
cp .env.example .env           # put NEARAI_API_KEY=sk-... in it; .env is gitignored
npm run seed -- payment-db-down   # emit a synthetic incident
npm start                     # http://localhost:3000
```

Open the UI, keep service `checkout` + last 30 minutes, hit **Triage privately**. Three synthetic incidents ship in `seed/scenarios.js`: `payment-db-down` (SEV1, 500s), `latency-regression` (SEV2, cache-miss storm), `inventory-crashloop` (SEV1, OOMKilled). All telemetry is **synthetic** — planted exceptions, fake services, invented numbers.

## Demo script

```bash
curl -X POST localhost:3000/api/seed -H 'content-type: application/json' -d '{"scenario":"payment-db-down"}'
curl -X POST localhost:3000/api/triage -H 'content-type: application/json' \
     -d '{"service":"checkout","sinceMinutes":30}'
```

In the UI: seed → query → telemetry view (Jaeger query + error spans + 5xx jump) → **Triage privately** → report + privacy panel.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | key configured? Jaeger/Prometheus reachable? |
| GET | `/api/scenarios` | list seedable incidents |
| POST | `/api/seed` | `{scenario}` — push synthetic OTLP traces + metrics |
| POST | `/api/telemetry` | `{service, sinceMinutes, maxTraces}` — fetch latest error data |
| POST | `/api/triage` | `{service, sinceMinutes, maxTraces}` or `{bundle}` — fetch → TEE triage → report |

## How it's built

Node 20+, Express, vanilla HTML/JS (no build step). `jaeger-client.js` and `prom-client.js` talk to the real query APIs of Jaeger and Prometheus. `near-client.js` calls `cloud-api.near.ai/v1/chat/completions` with the Confidential TEE model (`enable_thinking: false` for demo latency) and captures any attestation metadata the response carries. `prompt.js` holds the senior-SRE system prompt and the strict JSON report schema. Seeding is OTLP/HTTP JSON — the same wire format your real services would emit. Point `JAEGER_URL` / `PROM_URL` at your real stack and it works unchanged.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.
