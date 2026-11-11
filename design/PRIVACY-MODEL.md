# Privacy model

Track 3 is Privacy & Private AI. This document is what the privacy panel claims — and it must be
true, checkable, and honest about limits.

## 1 · Trust boundaries

```
┌─ browser (user) ─┐   HTTPS    ┌─ Triage Copilot server ─┐   HTTPS+Bearer   ┌─ NEAR AI Cloud ─┐
│  renders report  │ ─────────► │  holds key (env only)   │ ───────────────► │  Confidential    │
│  no key, no PII  │            │  builds evidence         │                  │  TEE: z-ai/…     │
│  handling         │ ◄───────── │  zero retention         │ ◄─────────────── │  prompt+output   │
└───────────────────┘            └──────────┬──────────────┘                  │  hidden even    │
                                            │ reads                            │  from NEAR     │
                                 ┌──────────▼──────────────┐                  └────────────────┘
                                 │ Jaeger / Prometheus /    │
                                 │ OTel collector (local)   │
                                 └─────────────────────────┘
```

## 2 · Asset inventory & controls

| Asset | Where it lives | Control |
|---|---|---|
| NEAR API key | `.env` (gitignored) → server env | never in repo/browser/logs/UI; errors sanitized; grep gate before commit |
| Incident evidence (spans, metrics, bundle) | in-request only | no DB, no files; logs carry sizes/timings only; nothing echoed into error messages |
| Model prompt & output | TEE only | Confidential TEE tier (`z-ai/glm-5.3-flash` on NEAR's own GPUs) — hidden from everyone, NEAR included |
| Attestation receipt | API response | captured and displayed verbatim; never synthesized |
| Demo telemetry | synthetic | all services, exceptions, numbers are fictional (stated in README + UI footer) |

## 3 · Threat → control mapping

| Threat | Control |
|---|---|
| Key leaks via repo/video/logs/chat | `.env` gitignored; sanitize `sk-…` in every error path; log policy (sizes/timings only); never print the key |
| Evidence persists after triage | zero-retention design; the evidence object lives inside one request handler |
| Provider (or NEAR) reads incident data | Confidential TEE tier — the entire point of the app |
| A judge doubts the privacy claim | tier badge + attestation/response metadata rendered in the UI + honest scope line |
| Overclaiming ("everything is private") | scope line says explicitly: *only the model call* is private; laptop/server/telemetry sit outside the TEE |

## 4 · What the privacy panel shows (exact content)

1. **Tier comparison** — three cards: Confidential TEE (this app, highlighted), Incognito (gateway-only
   TEE, not used), normal chatbot (not used: "your evidence would be stored on the provider's servers").
2. **Receipt** — attestation fields if the API returns any (headers/body matching
   `attest|proof|quote|tee|confid|seal`); otherwise response metadata: model, responseId, usage,
   latency, attempts — with the caption "this API response carried no attestation fields; the tier
   is the guarantee."
3. **Scope statement** — "Only the model call is private: it ran inside a Confidential TEE. This
   server stores nothing — evidence existed only for this request and was never written to disk or
   logs."
4. **Demo-fallback banner** (only if used) — "cached demo report — live call unavailable" so honesty
   survives even the fallback.

## 5 · Residual risks (accepted, stated)

- The laptop, browser, server and telemetry stack are outside the TEE — said out loud in the UI.
- Jaeger/Prometheus hold the (synthetic) telemetry — real deployments would point at the user's own
  stack; that boundary is theirs, not ours.
- The API may not surface attestation fields — degraded display, never faked.

## 6 · Submission hygiene checklist

- [ ] `git grep -i "sk-"` clean; `.env` absent from the repo; `.env.example` has no real value
- [ ] No key visible in the demo video (screen-record with a clean terminal)
- [ ] README privacy section = this document's claims, nothing stronger
- [ ] X post tags: @buidlcity @NEARProtocol @nearlegion #NEARHackathon
