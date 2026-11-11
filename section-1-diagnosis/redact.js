// Redaction rules — rule #1 of the design: "Redact first".
//
// The primary masking happens in the OpenTelemetry Collector (otel-collector.config.yaml,
// `transform/redact`), before telemetry is stored. It replaces each secret with a
// kind-named placeholder like [REDACTED:email] — the kind, never the value.
//
// This module is the second line: the server applies the SAME patterns to every
// evidence object before the model call (paste mode has no collector in front of it),
// and builds the redaction manifest the Verified panel shows: counts per kind, from
// both the collector's placeholders and its own masks. Values are never recorded.
//
// Keep the patterns in sync with otel-collector.config.yaml. Order matters:
// connection strings first (they contain user:password@host, which would
// otherwise half-match the email rule).

export const RULES = [
  { kind: "connection_string", re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|jdbc:[a-z]+):\/\/[^\s'"<>,;]+/gi },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { kind: "api_key", re: /\b(?:sk|pk|rk)[-_](?:live[-_]|test[-_])?[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { kind: "credential", re: /\b[A-Za-z0-9_]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[=:]\s*[^\s,;'"&]+/gi },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

const PLACEHOLDER = /\[REDACTED:([a-z_]+)\]/g;

/** Mask one string. Returns { text, counts } where counts is kind → number masked here. */
export function redactString(input) {
  let text = String(input);
  const counts = {};
  for (const { kind, re } of RULES) {
    text = text.replace(re, () => {
      counts[kind] = (counts[kind] || 0) + 1;
      return `[REDACTED:${kind}]`;
    });
  }
  return { text, counts };
}

/**
 * Deep-mask every string in a JSON-able value. Returns the masked copy and a manifest:
 *   collector: kinds already masked upstream (placeholders found), with counts
 *   server:    kinds this pass had to mask (should be empty when the collector did its job)
 */
export function redactEvidence(value) {
  const manifest = { collector: {}, server: {} };
  const add = (bucket, kind, n = 1) => (bucket[kind] = (bucket[kind] || 0) + n);

  const walk = (v) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(PLACEHOLDER)) add(manifest.collector, m[1]);
      const { text, counts } = redactString(v);
      for (const [k, n] of Object.entries(counts)) add(manifest.server, k, n);
      return text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const masked = walk(value);
  const total = (b) => Object.values(b).reduce((a, n) => a + n, 0);
  manifest.totals = { collector: total(manifest.collector), server: total(manifest.server) };
  return { masked, manifest };
}
