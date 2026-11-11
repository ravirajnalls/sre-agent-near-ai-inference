# Attested Agent Sandbox

> An open-source sandbox that runs any AI agent inside a TEE, with on-chain policy over what it can do. First agent: an SRE that debugs production without exposing your logs or secrets.

Built at the NEAR Private AI Hackathon NYC (Build City, Nov 11, 2026) for the global NEAR Hackathon — Track 3, Privacy & Private AI.

## The two sections

The project is split into two sections. The part that thinks never holds access; the part that holds access never thinks.

| Section | What it does | Status |
|---|---|---|
| **[Section 1 — Sealed Diagnosis](section-1-diagnosis/)** | A redacting OpenTelemetry Collector masks secrets before storage; the app queries the latest error telemetry, verifies **NEAR AI attestation with a fresh nonce** before sending anything, diagnoses on a **Confidential TEE model on NEAR AI Cloud**, checks the **signature on every reply**, and returns one proposed fix from a **fixed action list** (validated, never applied). | **Built Nov 11** — see its [README](section-1-diagnosis/README.md) ("do X, see Y" steps and the trust model's limits) |
| **[Section 2 — Gated Remediation](section-2-gating/)** | No fix runs without the contract: a redacting OpenTelemetry Collector in-cluster, a boxed agent with no network or credentials, and a **NEAR contract** that approves, parks or rejects every proposed fix. An executor applies only what the contract approved. | Planned — design complete, [build plan to Nov 14](section-2-gating/DESIGN.md) |

## Why NEAR is load-bearing

Section 2 makes the contract the only path from a diagnosis to a change in the cluster: remove NEAR and no fix can run. Section 1 already runs its model inference on NEAR AI Cloud's Confidential TEE tier and refuses to send evidence unless the attestation for a fresh nonce checks out; each check is shown in the UI. Section 1 has no contract yet: it proposes a fix but never applies one.

## Repository layout

```
section-1-diagnosis/   sealed diagnosis app (Node + Express, OTLP telemetry stack)
  design/              full design package: API contract, data models, privacy model,
                       UI design, verification & execution plan
  server.js, public/  the app and its ops-console UI
  seed/                synthetic incident generator (OTLP → collector → Jaeger/Prometheus)
section-2-gating/      gated remediation: design + build plan (collector redaction,
                       sandbox runtime, NEAR contract, executor, verified panel)
```

All telemetry in the demos is **synthetic** — planted exceptions, fictional services, invented numbers. See each section's README for what is built and what is planned; claims are kept matched to code.

## Quick start (Section 1)

```bash
cd section-1-diagnosis
cp .env.example .env          # add your NEAR AI Cloud API key ($10 hackathon credits:
                              #  nearbuilders.org/dashboard)
docker compose up -d --build  # SRE Agent app + Jaeger + Prometheus + OTel Collector
                              # → http://localhost:3000
```

Click **Simulate an incident → auth-secrets-leak**, then **Fetch telemetry** (secrets show as `[REDACTED:<kind>]`), **Triage privately**, and ask the agent a follow-up in the chat.

Part of the global [NEAR Hackathon](https://nearhackathon.com), Nov 1–14, 2026.
