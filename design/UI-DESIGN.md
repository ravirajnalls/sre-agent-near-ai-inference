# UI design

Dark "ops console" aesthetic — monospace, one column of controls, content flowing top-to-bottom in
three sections that mirror the story: **what happened → what it means → why it was private**.

## 1 · Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▲ TRIAGE COPILOT   private incident triage on confidential compute             │
│                    ● key  ● jaeger  ● prometheus   [Confidential TEE · model]  │
├──────────────┬─────────────────────────────────────────────────────────────────┤
│ INCIDENT     │  1 · TELEMETRY          checkout · last 30 min · 5 error traces │
│ QUERY        │  ┌───────────────────────────────────────────────────────────┐ │
│ service      │  │ GET /api/traces?service=checkout&start=…&limit=20         │ │
│ [checkout]   │  ├───────────────────────────────────────────────────────────┤ │
│ window       │  │ service   operation          status  dur    exception     │ │
│ [30 min ▾]   │  │ checkout  POST /api/checkout  500    1930ms ConnectTimeout│ │
│ max traces   │  │ payment   POST /v1/authorize  500    1680ms PSQLException │ │
│ [20 ▾]       │  ├───────────────────────────────────────────────────────────┤ │
│              │  │ increase(http_requests_total{…status=~"5.."}[35m])       │ │
│ [Fetch       │  │   route=/api/checkout status=500            266          │ │
│  telemetry]  │  │   route=/api/checkout status=200         2715 ▾          │ │
│ [▶ Triage    │  └───────────────────────────────────────────────────────────┘ │
│  privately]  │                                                                 │
│ SEED A       │  2 · TRIAGE REPORT          z-ai/glm-5.3-flash · 8.4s in TEE │
│ SYNTHETIC    │  ┌─ SEV1 ── root cause summary, confidence bar ──────────────┐ │
│ INCIDENT     │  │ evidence: bullets quoting spans/exceptions/metrics       │ │
│ [SEV1        │  │ blast radius: [checkout] [payment] [payments-db]          │ │
│  payment-    │  │ next actions: #1 … #2 … with copy-pasteable commands      │ │
│  db-down]    │  │ alternates / follow-ups                                   │ │
│ [SEV2 …]     │  └───────────────────────────────────────────────────────────┘ │
│ [SEV1 …]     │                                                                 │
│              │  3 · PRIVACY                                                   │
│ PASTE A      │  ┌ Confidential TEE ┐ Incognito (not used) ┐ chatbot (not used)│
│ BUNDLE       │  │ attestation / response metadata                │ scope     │
│ INSTEAD      │  │ statement — "only the model call is private"    │          │
│ [textarea]   │  └───────────────────────────────────────────────────────────┘ │
└──────────────┴─────────────────────────────────────────────────────────────────┘
```

## 2 · Interaction flow

1. **Boot** — `GET /api/health`: status dots (key/jaeger/prometheus), model badge fills in.
   Any red dot shows a hint tooltip ("start docker compose / add .env").
2. **Seed** — click a scenario button → `POST /api/seed` → toast "seeded payment-db-down — 5 traces";
   the suggested service auto-fills the query field.
3. **Fetch telemetry** (optional step for the demo) — `POST /api/telemetry` → section 1 renders:
   the Jaeger query string, the error-span table, the metric series with last values.
4. **Triage privately** — `POST /api/triage` → sections 1+2+3 render. Button shows a busy state
   ("consulting the TEE… ~10–30 s"). Section order = the narrative order.
5. **Paste mode** — textarea + button, same report + privacy rendering, telemetry section shows
   "paste mode — bundle sent through the same TEE call".

## 3 · States (never a dead end)

| State | Rendering |
|---|---|
| loading (telemetry) | "querying jaeger + prometheus …" |
| loading (triage) | "assembling evidence and consulting the Confidential TEE … ~10–30 seconds" |
| no error spans | hint: "no error spans in this window — widen the window or seed an incident" |
| model non-JSON ×2 | raw reply in a `<pre>` with explanation — never a stack trace |
| dependency down | red status dot + first-line error, rest of UI still usable |
| seed failure | toast with reason + "is docker compose up?" hint |

## 4 · Visual rules

- Palette: near-black `#0b0e14`, panel `#11151d`, accent green `#2ee6a8`, amber SEV2, red SEV1,
  blue SEV3 — severity badges always color-coded
- All queries, commands, spans in monospace; the Jaeger/PromQL strings are displayed verbatim
  (SRE judges recognize them instantly)
- Confidence rendered as a slim progress bar + integer %
- HTML-escape every model-supplied and user-supplied string before insertion

## 5 · Demo script (3 minutes, rehearsed)

| # | Action | What judges see |
|---|---|---|
| 1 | click **seed payment-db-down** | synthetic SEV1 emitted into Jaeger + Prometheus |
| 2 | click **Fetch telemetry** | real query APIs, real spans, real PromQL — no copy-paste |
| 3 | click **Triage privately** | 10–20 s pause — say: "the evidence is inside a TEE right now; nobody, NEAR included, can read it" |
| 4 | report renders | root cause citing exact spans; blast radius topology; ranked actions with commands |
| 5 | scroll to privacy panel | tier comparison, receipt, honest scope line |
| 6 | closer | "with a normal chatbot this evidence would be on their servers right now" |
