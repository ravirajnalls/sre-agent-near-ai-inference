# Section 2 — Gated Remediation: Design

> Source: "Attested Agent Sandbox: Architecture" (Nov 10, 2026, @Raviraj) — this section implements that document, staged on top of Section 1.

**Status: DESIGNED — not yet built.** Everything below is the plan of record for Nov 12–14.

## Summary

An open-source sandbox runs any AI agent inside a TEE, and a NEAR contract decides what that agent may do. The first agent is an SRE that diagnoses Kubernetes incidents without seeing secrets or holding cluster credentials.

Three rules shape everything else:

1. **Redact first.** Logs are stripped of secrets inside the cluster, before anything leaves it.
2. **The agent is boxed in.** It has no network and no credentials. It can only call the model through a verifying proxy and propose a fix.
3. **No fix runs without the contract.** The component that holds cluster access applies only what the NEAR contract approved.

## Components — seven parts, two trust zones

Split so that **the part that thinks never holds access and the part that holds access never thinks.**

| Component | Runs in | Job | Build with |
|---|---|---|---|
| OpenTelemetry Collector (the redactor) | your cluster | Streams pod logs, events, pod specs. Masks secrets, tokens, connection strings and emails in the pipeline; tags each record with the *kinds* of secret masked (never the values) | Collector contrib image as a DaemonSet; config only |
| Sandbox runtime | enclave | Receives redacted records over OTLP; builds the incident bundle on a failure event; verifies NEAR AI attestation (fresh nonce) before any model call and the signature on every reply; gives the agent a local OpenAI-style endpoint; submits proposals to the contract | Shade Agent framework (TypeScript) |
| Agent container | enclave | The reasoning loop: reads the bundle, calls the model through the runtime, returns a diagnosis and one proposed fix | any stack |
| NEAR AI Cloud | NEAR AI's TEE | Runs the model; returns an attestation report and signed replies | OpenAI-compatible API at cloud-api.near.ai/v1 |
| Agent contract | NEAR testnet | Holds approved enclave measurements, the policy, approvals and incident receipts | Rust, Shade agent contract template |
| Executor | your cluster | Watches the contract for approved fixes; applies them with a narrow ServiceAccount; reports the result | Python, RBAC limited to one namespace and a few verbs |
| Verified panel | operator's browser/CLI | Shows the redaction manifest, attestation checks, signature check, contract transactions | grows out of Section 1's UI |

### Collector pipeline (in-cluster)

| Stage | Collector component | Job |
|---|---|---|
| Read pod logs | `filelog` receiver | tails `/var/log/pods` on the node |
| Read events + pod specs | `k8sobjects` receiver | watches events, pulls pod objects for demo-apps |
| Label records | `k8sattributes` processor | adds namespace, pod, deployment names |
| Mask log text | `transform` processor | OTTL `replace_pattern` rules on the log body; sets a tag naming each kind of secret masked |
| Mask attributes | `redaction` processor | masks attribute values, adds `redaction.masked.count` |
| Send out | `otlphttp` exporter | ships to the sandbox runtime |

Three things to know before building:

- The `redaction` processor only handles attributes and map-shaped bodies, and its log support is alpha. Plain log lines must be masked by the `transform` processor — that is where most rules live.
- The Collector sends a continuous stream, not a bundle. The runtime keeps the last few minutes of records per workload and builds the bundle when a failure event arrives.
- Pods need a route to the runtime on your laptop: `host.docker.internal` on Docker Desktop, or attach the runtime container to the kind Docker network on Linux.

### kind cluster layout

One node, three namespaces: the broken apps, the redacting Collector, the executor.

## Incident flow (11 steps, demoable in under two minutes)

1. A workload fails — demo case: a pod stuck in CrashLoopBackOff.
2. The Collector is already streaming redacted logs, events and pod specs to the runtime.
3. The runtime sees the failure event and builds a bundle from that workload's last few minutes.
4. The runtime fetches the NEAR AI attestation with a fresh nonce and verifies it — or stops.
5. The agent reads the bundle and calls the model through the runtime, which checks each reply's signature.
6. The agent returns a diagnosis and one proposed fix from a fixed action list.
7. The runtime submits the proposal to the contract, with hashes of the diagnosis and the attestation.
8. The contract applies the policy: allowlisted action in an allowed namespace → approved; unknown action type → rejected; anything else → parked.
9. For a parked fix, the on-call engineer approves or rejects from a NEAR wallet.
10. The executor sees the approval, applies the fix, records the result on the contract.
11. The Verified panel shows the manifest, the checks and the transaction links.

## Trust model — every defence with its stated limit

| Threat | Defence | Limit |
|---|---|---|
| The model provider reads your logs | inference runs in a TEE; attestation verified before any data is sent | a bug inside the enclave can still expose requests (see the Nov 8 incident) — that is why redaction comes first |
| Secrets leave the cluster | the Collector masks them in-cluster and tags what it masked | pattern-based; an unusual secret format can slip through |
| Agent hijacked by text in a log | no network, no credentials, fixed action types, the contract gate | a wrong-but-allowlisted fix can still run — keep the allowlist small |
| Someone swaps the agent's code | the enclave measurement must match one approved on the contract | day-one build runs local mode with no real attestation — and must say so |
| The record is altered afterwards | hashes, approvals and results are on NEAR | only hashes are on chain; the report stays with the operator |
| The executor is compromised | narrow RBAC: one namespace, a few verbs | it sits inside your own trust boundary |

The README repeats these limits — AI screeners check claims against the code.

## NEAR's role

The contract is the only path from a diagnosis to a change in the cluster. NEAR is load-bearing: remove it and no fix can run. Guardrails live in the contract so they hold even if the enclave is compromised.

| Method | Caller | What it does | Origin |
|---|---|---|---|
| approve measurements & PPIDs | owner | lists which enclave code and which TEE hardware may register | Shade template |
| `register_agent` | the enclave | verifies attestation against approved measurements, stores the agent (0.00486 NEAR deposit) | Shade template |
| `require_valid_agent` | internal | gate at the top of every agent-only method | Shade template |
| `set_policy` | owner | allowed namespaces, auto-approved action types, approval-required types, hourly action cap | ours |
| `propose_action` | registered agent only | stores the action with diagnosis + attestation hashes; approves, rejects or parks per policy | ours |
| `approve_action` / `reject_action` | approver account | human decision on a parked action | ours |
| `record_result` | executor account | stores success/failure for an approved action | ours |
| `get_incident` | anyone | full receipt for the Verified panel | ours |

The executor gets a function-call access key limited to `record_result` on this one contract — explained in the README.

## Any stack, but not any unreviewed code

An agent is any container image following four conventions; the framework inside doesn't matter:

- **Model access:** `OPENAI_BASE_URL` points at the runtime's local endpoint — any OpenAI-compatible SDK works unchanged.
- **Input:** the redacted bundle is mounted read-only at `/incident/bundle.json`.
- **Output:** writes `/out/result.json` with a `diagnosis` and one `action` (`type`, `namespace`, `target`, `params`).
- **Network:** none, apart from the runtime endpoint.

Action types are a fixed list: `restart_rollout`, `rollback_rollout`, `set_image`, `set_resources`, `scale`, `none`. The runtime rejects anything else before it reaches the contract. To prove the claim, ship two agents through the same sandbox and policy: one in Python (LangChain), one as a short script in another language. Each agent image must be approved on the contract before it can register (the enclave measurement covers the compose file).

## Build plan — Nov 12 to Nov 14, 23:59 UTC

Order, riskiest first:

1. One NEAR AI call with a **verified attestation**, from a script (Section 1's V0 probe feeds this).
2. OpenTelemetry Collector with masking rules against the kind cluster — **with the known-secrets pipeline test from day one** (it proves rule #1).
3. Runtime proxy and the agent container.
4. Contract and executor.
5. Verified output; record the demo before 4:00 PM.

| Part | Nov 11 (Section 1) | By Nov 14, 23:59 UTC |
|---|---|---|
| Cluster | — (local telemetry stack) | kind with three broken workloads; add log-injection scenario |
| Redaction | — | OTTL masking rules + redaction tags; more patterns; secrets-through-pipeline test |
| Sandbox | diagnosis over TEE model call | runtime + agent deployed to a TEE on Phala Cloud, registered with real attestation |
| Model checks | tier badge + response metadata (honest fallback) | attestation with nonce + reply signature; OTLP over TLS terminating inside the enclave |
| Contract | — | testnet: policy, propose, approve, result; measurements approved; executor on a function-call key |
| Agents | — | one Python agent; a second in a different stack |
| For screeners | README as "do X, see Y" | offline fixtures, test suites, demo video |

## Repo layout (when built)

```
section-2-gating/
  otel/        collector config: receivers, masking rules, exporter
  runtime/     OTLP intake, bundle builder, model proxy, attestation + signature checks, contract client
  agents/sre-py/    first agent
  agents/sre-alt/  second agent in another stack
  contract/   Rust agent contract with policy and receipts
  executor/   watches approvals, applies fixes, records results
  panel/      verified view (extends Section 1's UI)
  scenarios/  broken workloads and recorded incident fixtures
```

## Open questions to settle before building on them

- **Exact attestation and signature endpoints/parameters.** The NEAR AI verification docs were unreachable while writing the source doc — confirm them and reuse the official verifier instead of writing one.
- Whether **Shade local mode** sets up fast enough. Fallback: a plain contract that trusts one whitelisted account, labelled as such.
- Whether a **Phala Cloud** deployment can run the agent container with outbound network fully blocked, and what it costs (do hackathon credits cover it?).
- Whether the NYC event has its own prizes or only feeds the global submission.

## Sources

Shade Agent framework overview · Shade agent contract reference · Privacy track starter prompt · HACKATHON.md rules · TEE Receipts (on-chain signature verification) · Hacker News coverage of the Nov 8 incident
