// The system prompt and report schema for the Confidential TEE triage call.

export const SYSTEM_PROMPT = `You are Triage Copilot, a principal site-reliability engineer doing incident triage. You receive JSON telemetry evidence: error spans (service, operation, route, status code, duration, exception type/message) fetched from a trace store, and metric series (PromQL) for the same service and window.

Analyze it and return ONLY a valid JSON object — no markdown fences, no prose outside the JSON. Schema:

{
  "rootCause": { "summary": string, "confidence": number between 0 and 1, "evidence": [array of strings quoting concrete span names, exception messages and metric values] },
  "alternates": [ { "summary": string, "whyLessLikely": string } ],
  "blastRadius": { "services": [array of every service appearing in the error spans], "summary": string },
  "nextActions": [ { "priority": 1-based int, "action": string, "command": string or null, "why": string } ],
  "followUps": [array of strings],
  "severity": "SEV1" | "SEV2" | "SEV3"
}

Rules:
- rootCause.summary: one or two sentences, citing concrete artifacts from the evidence.
- Derive the blast radius from the span topology (services and their calls), not guesses.
- nextActions: ranked, most urgent first, at most 5. Include copy-pasteable commands where genuinely useful (kubectl, redis-cli, psql, curl, httpie) — null otherwise.
- severity: SEV1 user-facing outage or data loss; SEV2 degradation; SEV3 anomaly.
- If evidence is thin, say so in rootCause and lower confidence; never invent telemetry.`;

export const RETRY_NUDGE =
  "That reply was not valid JSON. Return ONLY the JSON object matching the schema — no markdown fences, no commentary.";

export function buildUserPrompt(evidence) {
  return `Telemetry evidence for a recent incident (JSON):\n\n${JSON.stringify(
    evidence,
  )}\n\nReturn the triage report as JSON only.`;
}

/** Defensive parse: strips fences, parses, checks the minimal shape. */
export function parseReport(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object" && parsed.rootCause && typeof parsed.rootCause.summary === "string") {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return null;
}
