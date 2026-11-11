// Triage Copilot — private incident triage on NEAR AI Cloud Confidential TEE models.
// Zero retention: telemetry evidence exists only for the duration of a request;
// logs contain sizes and timings, never content; the API key never leaves this process.

import { loadEnv } from "./env.js";
loadEnv();

import express from "express";
import { fetchTelemetry, toUi, buildEvidence } from "./telemetry.js";
import { triageComplete, tierInfo } from "./near-client.js";
import { SYSTEM_PROMPT, RETRY_NUDGE, buildUserPrompt, parseReport } from "./prompt.js";
import { SCENARIOS, seedScenario } from "./seed/scenarios.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const sanitize = (msg) => String(msg).replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");

// --- health -----------------------------------------------------------------

app.get("/api/health", async (_req, res) => {
  const [j, p] = await Promise.allSettled([
    fetch(`${process.env.JAEGER_URL || "http://localhost:16686"}/api/services`, { headers: { accept: "application/json" } }),
    fetch(`${process.env.PROM_URL || "http://localhost:9090"}/api/v1/status/buildinfo`),
  ]);
  res.json({
    keyConfigured: Boolean(process.env.NEARAI_API_KEY),
    model: process.env.NEAR_MODEL || "z-ai/glm-5.3-flash",
    tier: tierInfo.tier,
    jaeger: j.status === "fulfilled" && j.value.ok ? "ok" : "unreachable",
    prometheus: p.status === "fulfilled" && p.value.ok ? "ok" : "unreachable",
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
    const evidenceChars = JSON.stringify(evidence).length;
    const userPrompt = buildUserPrompt(evidence);

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
        attempts,
        modelMs: lastResult?.elapsedMs,
        totalMs: Date.now() - started,
        parsed: Boolean(report),
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
        attestation: lastResult?.meta,
        scope:
          "Only the model call is private: it ran inside a Confidential TEE. This server stores nothing — evidence existed only for this request and was never written to disk or logs.",
      },
    });
  } catch (e) {
    console.log(JSON.stringify({ at: new Date().toISOString(), route: "triage", error: sanitize(e.message).slice(0, 120) }));
    res.status(502).json({ error: sanitize(e.message) });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Triage Copilot → http://localhost:${port}`);
  if (!process.env.NEARAI_API_KEY) {
    console.log("NEARAI_API_KEY is not set — triage will fail until you add it to .env");
  }
});
