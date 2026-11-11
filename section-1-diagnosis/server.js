// Attested Agent Sandbox — Section 1: Sealed Diagnosis.
// Private incident triage on NEAR AI Cloud Confidential TEE models.
// Zero retention: telemetry evidence exists only for the duration of a request;
// logs contain sizes and timings, never content; the API key never leaves this process.

import { loadEnv } from "./env.js";
loadEnv();

import express from "express";
import { fetchTelemetry, toUi, buildEvidence } from "./telemetry.js";
import { triageComplete, tierInfo } from "./near-client.js";
import { verifyAttestation, verifyReplySignature, attestationMode, VerificationError } from "./attestation.js";
import { SYSTEM_PROMPT, RETRY_NUDGE, buildUserPrompt, parseReport } from "./prompt.js";
import { SCENARIOS, seedScenario } from "./seed/scenarios.js";
import { redactEvidence } from "./redact.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const sanitize = (msg) => String(msg).replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");

// --- health -----------------------------------------------------------------

app.get("/api/health", async (_req, res) => {
  const [j, p, c] = await Promise.allSettled([
    fetch(`${process.env.JAEGER_URL || "http://localhost:16686"}/api/services`, { headers: { accept: "application/json" } }),
    fetch(`${process.env.PROM_URL || "http://localhost:9090"}/api/v1/status/buildinfo`),
    fetch(`${process.env.OTEL_COLLECTOR_URL ? process.env.OTEL_COLLECTOR_URL.replace(":4318", ":13133") : "http://localhost:13133"}`),
  ]);
  res.json({
    keyConfigured: Boolean(process.env.NEARAI_API_KEY),
    model: process.env.NEAR_MODEL || "z-ai/glm-5.3-flash",
    tier: tierInfo.tier,
    attestationMode: attestationMode(),
    jaeger: j.status === "fulfilled" && j.value.ok ? "ok" : "unreachable",
    prometheus: p.status === "fulfilled" && p.value.ok ? "ok" : "unreachable",
    collector: c.status === "fulfilled" && c.value.ok ? "ok" : "unreachable",
  });
});

// --- scenarios / seeding ----------------------------------------------------

app.get("/api/scenarios", (_req, res) => {
  res.json(
    Object.entries(SCENARIOS).map(([id, s]) => ({
      id,
      severity: s.severity,
      service: s.service,
      summary: s.summary,
    })),
  );
});

app.post("/api/seed", async (req, res) => {
  try {
    const { scenario, windowMinutes } = req.body || {};
    const result = await seedScenario(scenario, { windowMinutes });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: sanitize(e.message) });
  }
});

// --- telemetry --------------------------------------------------------------

app.post("/api/telemetry", async (req, res) => {
  try {
    const { service = "checkout", sinceMinutes = 30, maxTraces = 20 } = req.body || {};
    const telemetry = await fetchTelemetry({ service, sinceMinutes, maxTraces });
    res.json(toUi(telemetry));
  } catch (e) {
    res.status(502).json({ error: sanitize(e.message) });
  }
});

// --- triage: telemetry (or pasted bundle) → Confidential TEE model → report -

app.post("/api/triage", async (req, res) => {
  const started = Date.now();
  let attestation = null;
  const signatures = [];
  try {
    const { service = "checkout", sinceMinutes = 30, maxTraces = 20, bundle } = req.body || {};

    let telemetry = null;
    let evidence;
    if (typeof bundle === "string" && bundle.trim()) {
      const clipped = bundle.slice(0, 60_000);
      evidence = { mode: "paste", incidentBundle: clipped };
    } else {
      telemetry = await fetchTelemetry({ service, sinceMinutes, maxTraces });
      evidence = buildEvidence(telemetry);
    }
    // Rule #1, second line: the collector already masked secrets in telemetry;
    // re-check every string here (paste mode has no collector in front of it).
    // The manifest records kinds and counts only, never values.
    const { masked, manifest: redaction } = redactEvidence(evidence);
    evidence = masked;
    const evidenceChars = JSON.stringify(evidence).length;
    const userPrompt = buildUserPrompt(evidence);

    // Design step 4: verify NEAR AI attestation with a fresh nonce BEFORE any
    // evidence leaves this process. In strict mode a failed check throws here.
    attestation = await verifyAttestation();

    // One retry-nudge if the model doesn't return clean JSON; then degrade to raw text.
    let report = null;
    let rawText = null;
    let lastResult = null;
    let attempts = 0;
    while (!report && attempts < 2) {
      attempts++;
      const messages =
        attempts === 1
          ? [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ]
          : [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
              { role: "assistant", content: rawText || "" },
              { role: "user", content: RETRY_NUDGE },
            ];
      lastResult = await triageComplete(messages);
      // Design step 5: check the signature on every reply (strict mode throws).
      signatures.push(await verifyReplySignature(lastResult, attestation));
      rawText = lastResult.content;
      report = parseReport(rawText);
    }

    // Logs carry sizes and timings only — never telemetry or model output.
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        route: "triage",
        mode: evidence.mode,
        service: evidence.mode === "telemetry" ? evidence.window.service : null,
        evidenceChars,
        maskedByCollector: redaction.totals.collector,
        maskedByServer: redaction.totals.server,
        attempts,
        modelMs: lastResult?.elapsedMs,
        totalMs: Date.now() - started,
        parsed: Boolean(report),
        attestationVerified: attestation.verified,
        signaturesVerified: signatures.every((s) => s.verified),
      }),
    );

    res.json({
      report,
      rawText: report ? undefined : rawText,
      telemetry: telemetry ? toUi(telemetry) : null,
      privacy: {
        tier: tierInfo.tier,
        tierDetail: tierInfo,
        model: lastResult?.model,
        responseId: lastResult?.id,
        usage: lastResult?.usage,
        modelMs: lastResult?.elapsedMs,
        attempts,
        verification: { mode: attestation.mode, attestation, signatures },
        redaction,
        scope:
          (attestation.verified
            ? "Only the model call is private: it ran on a Confidential TEE node whose attestation and reply signatures were verified for this request. "
            : `Only the model call is private, and for this request that is NOT verified (ATTESTATION_MODE=${attestation.mode}): the tier is claimed, not proven. `) +
          "This server stores nothing — evidence existed only for this request and was never written to disk or logs.",
      },
    });
  } catch (e) {
    console.log(JSON.stringify({ at: new Date().toISOString(), route: "triage", error: sanitize(e.message).slice(0, 120) }));
    const verification =
      e instanceof VerificationError
        ? { mode: attestationMode(), attestation: attestation || e.verification, signatures: attestation ? [...signatures, e.verification] : [] }
        : undefined;
    res.status(502).json({ error: sanitize(e.message), verification });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Attested Agent Sandbox (section 1) → http://localhost:${port}`);
  if (!process.env.NEARAI_API_KEY) {
    console.log("NEARAI_API_KEY is not set — triage will fail until you add it to .env");
  }
});
