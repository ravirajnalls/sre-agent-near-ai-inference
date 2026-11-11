// NEAR AI Cloud client — the only place the API key is ever read.
// The key lives in NEARAI_API_KEY (env / .env), never in the repo, browser or logs.

export const BASE = () => process.env.NEAR_BASE_URL || "https://cloud-api.near.ai/v1";
export const MODEL = () => process.env.NEAR_MODEL || "Qwen/Qwen3.6-35B-A3B-FP8";

function apiKey() {
  const key = process.env.NEARAI_API_KEY;
  if (!key) {
    throw new Error("NEARAI_API_KEY is not set — copy .env.example to .env and add your key");
  }
  return key;
}

function extraBody() {
  const raw = process.env.NEAR_EXTRA_BODY;
  if (!raw) return { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    console.log("NEAR_EXTRA_BODY is not valid JSON — ignoring it");
    return {};
  }
}

/** fetch with a hard timeout and a readable error when it fires. */
async function timedFetch(url, init, timeoutMs, what) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { res, text };
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error(`${what} did not answer within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  }
}

/**
 * Run a chat completion against NEAR AI Cloud on a Confidential TEE model.
 * Thinking is disabled: a live demo cannot survive minute-long pauses.
 *
 * Returns the exact request body string and response text as well, because the
 * reply signature covers sha256(request body) and sha256(response text).
 */
export async function triageComplete(messages, opts = {}) {
  const key = apiKey();
  const body = {
    model: MODEL(),
    messages,
    temperature: opts.temperature ?? 0.2,
    // Thinking off. Measured Nov 11 on NEAR AI Cloud: Qwen3.6-35B-A3B answers a triage
    // prompt in <1s with both flags below; z-ai/glm-5.3-flash ignores them and reasons
    // for minutes on a full incident (too slow for a live demo).
    // Override with NEAR_EXTRA_BODY='{"...":...}' in .env without a code change.
    ...extraBody(),
  };
  const requestBody = JSON.stringify(body);
  const started = Date.now();
  // ADR-007: a hung model call must not hang the request (or the demo).
  // Reasoning on a full incident prompt can take a minute or more.
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.NEAR_TIMEOUT_MS) || 150_000);
  const { res, text } = await timedFetch(
    `${BASE()}/chat/completions`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: requestBody,
    },
    timeoutMs,
    "NEAR AI Cloud",
  );
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
    requestBody,
    responseText: text,
  };
}

/**
 * GET /v1/attestation/report?model&nonce&signing_algo=ecdsa
 * Same call the official nearai-cloud-verifier makes. Returns { json, text }.
 */
export async function fetchAttestationReport(nonce, opts = {}) {
  const key = apiKey();
  const params = new URLSearchParams({ model: MODEL(), nonce, signing_algo: "ecdsa" });
  const { res, text } = await timedFetch(
    `${BASE()}/attestation/report?${params}`,
    { headers: { authorization: `Bearer ${key}`, accept: "application/json" } },
    opts.timeoutMs ?? 20_000,
    "NEAR AI attestation endpoint",
  );
  if (!res.ok) throw new Error(`attestation report HTTP ${res.status}: ${text.slice(0, 160)}`);
  return { json: JSON.parse(text), text };
}

/**
 * GET /v1/signature/{chat_id}?model&signing_algo=ecdsa
 * Returns { text, signature, signing_address, signing_algo }.
 */
export async function fetchReplySignature(chatId, opts = {}) {
  const key = apiKey();
  const params = new URLSearchParams({ model: MODEL(), signing_algo: "ecdsa" });
  const { res, text } = await timedFetch(
    `${BASE()}/signature/${encodeURIComponent(chatId)}?${params}`,
    { headers: { authorization: `Bearer ${key}`, accept: "application/json" } },
    opts.timeoutMs ?? 15_000,
    "NEAR AI signature endpoint",
  );
  if (!res.ok) throw new Error(`signature HTTP ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

export const tierInfo = {
  tier: "Confidential TEE",
  runsWhere: "NEAR's own GPUs",
  private: "Prompt and output hidden from everyone, NEAR included",
};
