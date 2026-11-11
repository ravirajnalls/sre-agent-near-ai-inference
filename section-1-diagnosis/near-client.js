// NEAR AI Cloud client — the only place the API key is ever read.
// The key lives in NEARAI_API_KEY (env / .env), never in the repo, browser or logs.

const BASE = () => process.env.NEAR_BASE_URL || "https://cloud-api.near.ai/v1";
const MODEL = () => process.env.NEAR_MODEL || "z-ai/glm-5.3-flash";

/**
 * Run a chat completion against NEAR AI Cloud on a Confidential TEE model.
 * Thinking is disabled: a live demo cannot survive minute-long pauses.
 */
export async function triageComplete(messages, opts = {}) {
  const key = process.env.NEARAI_API_KEY;
  if (!key) {
    throw new Error("NEARAI_API_KEY is not set — copy .env.example to .env and add your key");
  }
  const body = {
    model: MODEL(),
    messages,
    temperature: opts.temperature ?? 0.2,
    // GLM 5.3 Flash thinks by default; turn it off for demo latency (per hackpack).
    chat_template_kwargs: { enable_thinking: false },
  };
  const started = Date.now();
  // ADR-007: a hung model call must not hang the request (or the demo).
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.NEAR_TIMEOUT_MS) || 60_000);
  let res;
  let text;
  try {
    res = await fetch(`${BASE()}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error(`NEAR AI Cloud did not answer within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  }
  const elapsedMs = Date.now() - started;
  if (!res.ok) {
    throw new Error(`NEAR AI Cloud HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("NEAR AI Cloud returned a non-JSON response");
  }
  const content = json.choices?.[0]?.message?.content ?? "";
  return {
    content,
    model: json.model || MODEL(),
    id: json.id,
    usage: json.usage,
    elapsedMs,
    meta: collectAttestation(res.headers, json),
  };
}

/**
 * Capture whatever attestation-ish metadata the response carries
 * (headers or top-level body fields). Returns null when nothing matches,
 * so the UI can degrade gracefully to the tier badge + response metadata.
 */
function collectAttestation(headers, body) {
  const rx = /attest|proof|quote|tee|confid|seal/i;
  const found = {};
  for (const [k, v] of headers.entries()) {
    if (rx.test(k)) found[`header:${k}`] = String(v).slice(0, 500);
  }
  for (const [k, v] of Object.entries(body)) {
    if (rx.test(k) && typeof v !== "object") found[`body:${k}`] = String(v).slice(0, 500);
  }
  return Object.keys(found).length ? found : null;
}

export const tierInfo = {
  tier: "Confidential TEE",
  runsWhere: "NEAR's own GPUs",
  private: "Prompt and output hidden from everyone, NEAR included",
};
