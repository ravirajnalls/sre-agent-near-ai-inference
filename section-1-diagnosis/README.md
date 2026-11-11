# Attested Agent Sandbox — Section 1: Sealed Diagnosis

> For on-call engineers, the Attested Agent Sandbox finds root cause in production incident telemetry inside a TEE, without your secrets ever reaching the model.

Built at the **NEAR Private AI Hackathon NYC** (Build City, Nov 11, 2026) for Track 3 — Privacy & Private AI.

## The problem

The highest-signal incident data — error spans, exception messages, failing routes, error-rate spikes — is exactly what you can't paste into a normal chatbot: it contains customer tokens, internal topology, PII, secrets. So triage stays manual and slow.

## What Section 1 does, and which design rule each step serves

| Step | What happens | Design rule |
|---|---|---|
| 1 | Telemetry flows through an **OpenTelemetry Collector that masks secrets** (connection strings, JWTs, bearer tokens, API keys, `password=`-style credentials, emails) and tags each span with the *kinds* it masked — never the values. Jaeger only ever stores masked text. | Redact first |
| 2 | You pick a service + window; the app queries Jaeger (traces) and Prometheus (metrics) and builds a compact evidence object. The server **re-applies the same masking rules** (this also covers paste mode) and records a manifest of kinds and counts. | Redact first |
| 3 | Before any evidence is sent, the server fetches **NEAR AI's attestation report with a fresh 32-byte nonce** and checks it. In `strict` mode a failed check stops here. | Attested model |
| 4 | The evidence goes to a **Confidential TEE model on NEAR AI Cloud** (`z-ai/glm-5.3-flash`). The **signature on every reply** is checked against our exact request and response and the attested key. | Attested model |
| 5 | The model returns a diagnosis and **one proposed fix from a fixed list** of six action types. Code validates it; anything off-list or malformed is rejected. Nothing is applied. | No fix runs without the contract (first gate) |
| 6 | The **privacy panel** shows the redaction manifest, each attestation and signature check as pass/fail/skip, and the proposed action's status. | Verified panel |

The app itself is **zero-retention**: no database, no files, no logs of your telemetry. Logs carry sizes, timings and pass/fail flags only.

## Run it: do X, see Y

Prerequisites: Docker and a NEAR AI Cloud API key ([nearbuilders.org/dashboard](https://nearbuilders.org/dashboard)). Node 20+ only for tests or local development.

```bash
cd section-1-diagnosis
cp .env.example .env            # put NEARAI_API_KEY=sk-... in it; .env is gitignored
docker compose up -d --build    # SRE Agent app (3000) + Jaeger (16686) + Prometheus (9090) + OTel Collector (4318)
open http://localhost:3000      # or just browse to it
docker compose logs -f app      # app logs (also in Docker Desktop): timings and pass/fail only
```

The API key reaches the `app` container from `.env` at runtime and is never copied into the image (`.dockerignore`). Tests and local development without the app container:

```bash
npm install && npm test         # redaction + action-list tests (no network needed)
docker compose stop app && npm start   # run the app on the host instead
```

1. **Click `auth-secrets-leak`** under *Simulate an incident*, then **Fetch telemetry**.
   **See:** the error spans show `[REDACTED:connection_string]`, `[REDACTED:jwt]`, `[REDACTED:credential]`, `[REDACTED:email]` where the seed planted fake secrets. Jaeger (http://localhost:16686) shows the same masked text and `redaction.masked.<kind>` tags: nothing unmasked was ever stored.
2. **Click Triage privately.**
   **See:** the privacy panel's redaction manifest lists the kinds masked *in the collector* and `0` masked in the server.
3. **Look at the attestation block.**
   **See:** `report fetched` with a fresh nonce, `nonce echoed`, `TDX report_data binds signing key + nonce`, `NVIDIA GPU attestation (NRAS)` all ✓, then a ✓ list for each reply signature, and the attestation report's sha256.
4. **Look at the proposed fix.**
   **See:** one action such as `none` (a credential problem needs a human) or `set_resources prod/inventory-api {...}` for `inventory-crashloop`, marked *valid* or *rejected by the runtime*.
5. **Paste a bundle** containing a fake secret (e.g. `AUTH_DB_PASSWORD=hunter2 jane@example.com`) and click *Triage pasted bundle*.
   **See:** the manifest shows those kinds masked *in the server*, because paste mode has no collector in front of it.
6. **Ask the SRE agent** a follow-up in the chat under the report, e.g. *why not the database?* Include a fake secret in the question.
   **See:** your message is shown masked ("masked before sending"), and each answer carries an *attested · signature verified* badge.
7. **Break attestation on purpose:** set `NEAR_BASE_URL` to a wrong host, restart, triage again.
   **See:** the request stops with *"NEAR AI attestation did not verify — no evidence was sent to the model"* and the failing check is shown.

There is no live production system in the demo, so **Simulate an incident** stands in for one: it pushes a synthetic outage's traces and metrics through the redacting collector, the way real services would. Four synthetic incidents ship in `seed/scenarios.js`: `payment-db-down` (SEV1), `latency-regression` (SEV2), `inventory-crashloop` (SEV1, OOMKilled), `auth-secrets-leak` (SEV1, planted fake secrets). All telemetry is **synthetic**.

### Verification modes

`ATTESTATION_MODE` in `.env`:

| Mode | Behaviour |
|---|---|
| `strict` (default) | Any failed attestation check stops the triage before evidence is sent; any failed reply-signature check discards the report. |
| `warn` | Checks run and failures are shown, but the triage continues. The panel and scope line say *NOT verified*. |
| `off` | Local mode: no checks. The panel says so. Use only when NEAR AI's attestation endpoint is unreachable. |

## Trust model and its limits

Every defence has a stated limit. These are the claims the code makes, no stronger.

| Threat | Defence in this code | Limit |
|---|---|---|
| The model provider reads your telemetry | Inference runs on NEAR AI's Confidential TEE tier; attestation with a fresh nonce is checked **before** any data is sent, and every reply's signature is checked | A bug inside the enclave can still expose requests. That is why redaction comes first. |
| The attestation is faked | Nonce echo; TDX `report_data` must bind the signing key and our nonce; NVIDIA NRAS must accept the GPU evidence; replies must be signed by an attested key | **The Intel TDX quote's own certificate chain (DCAP collateral) is not checked in-app.** Run the official [nearai-cloud-verifier](https://github.com/nearai/nearai-cloud-verifier) for that. The panel lists it as *skip*. The NRAS verdict is read from NVIDIA's token without verifying the token's signature. |
| Secrets leave your machine | Collector masks them before storage and tags the kinds; the server re-masks every evidence string and paste-mode input | Pattern-based: an unusual secret format can slip through. |
| A log line hijacks the model | Evidence is labelled as data in the prompt; the fix must be one of six action types with validated params | A wrong fix that is on the list can still be proposed. Nothing in Section 1 applies it. |
| Someone swaps the agent's code | — | **Not addressed in Section 1.** The server runs on your laptop, not in an enclave, and there is no on-chain measurement yet. That is Section 2. |
| A fix runs without approval | Section 1 applies nothing | The NEAR contract gate and executor are Section 2 (planned, not built). |

Also stated plainly in the UI: **only the model call is private.** Your laptop, this server and the telemetry stack sit outside the TEE. The API key exists only in the server's environment, never in the repo or the browser.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | key configured? attestation mode? Jaeger/Prometheus/collector reachable? |
| GET | `/api/scenarios` | list seedable incidents |
| POST | `/api/seed` | `{scenario}` — push synthetic OTLP traces + metrics |
| POST | `/api/telemetry` | `{service, sinceMinutes, maxTraces}` — fetch latest error data |
| POST | `/api/triage` | `{service, sinceMinutes, maxTraces}` or `{bundle}` — mask → attest → TEE triage → verify signature → validate action → report |
| POST | `/api/chat` | `{context, history, question}` — follow-up question on a triaged incident; same mask → attest → verify path every turn. The browser holds the masked context and history; the server keeps nothing |

## How it's built

| File | Job |
|---|---|
| `otel-collector.config.yaml` | `transform/redact` (OTTL `replace_all_patterns` / `replace_pattern` on span and event attributes and status messages, plus `redaction.masked.<kind>` tags) and a `redaction` processor backstop |
| `redact.js` | the same rules applied server-side; builds the redaction manifest |
| `attestation.js` | nonce, report checks, NRAS, EIP-191 reply-signature recovery (`@noble/curves`, `@noble/hashes`) |
| `near-client.js` | the only place the API key is read: chat completions, attestation report, reply signature, timeouts (150 s for the model call, `NEAR_TIMEOUT_MS`) |
| `prompt.js` | system prompt, report schema, fixed action list and `validateAction` |
| `server.js`, `public/` | Express app and the ops-console UI |
| `test/` | `npm test`: planted secrets never survive; off-list or malformed actions are rejected |

Node 20+, Express, vanilla HTML/JS (no build step). Point `JAEGER_URL` / `PROM_URL` at your real stack and route your services through the collector config to use it on real telemetry.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [design/](design/DESIGN.md) for the design package, and [../section-2-gating/DESIGN.md](../section-2-gating/DESIGN.md) for what comes next.
